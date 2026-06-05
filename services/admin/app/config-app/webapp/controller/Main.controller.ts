import Controller from "sap/ui/core/mvc/Controller";
import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import Table from "sap/m/Table";
import Dialog from "sap/m/Dialog";
import CodeEditor from "sap/ui/codeeditor/CodeEditor";
import FlexibleColumnLayoutControl from "sap/f/FlexibleColumnLayout";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import Control from "sap/ui/core/Control";

/**
 * Main controller for Configuration Management
 */
export default class MainController extends Controller {

    private _selectedConfig: any = null;
    private _originalEditorValue: string = "";
    private _isEditorDirty: boolean = false;
    private _programmaticEditor: CodeEditor | null = null;
    private _searchTimeout: number | null = null;
    private _filterTimeout: number | null = null;
    private _dialogResizeObserver: ResizeObserver | null = null;
    private _resizeThrottleTimeout: number | null = null;

    /**
     * Helper: wait until a control has rendered once
     */
    private _afterRenderingOnce(control: Control): Promise<void> {
        return new Promise((resolve) => {
            if (control.getDomRef()) {
                // Already rendered
                resolve();
                return;
            }
            
            const delegate = {
                onAfterRendering: () => {
                    control.removeEventDelegate(delegate);
                    resolve();
                }
            } as any;
            control.addEventDelegate(delegate);
        });
    }

    public onInit(): void {
        // Ensure we have the viewModel before proceeding
        const oView = this.getView();
        let oVM = oView?.getModel("viewModel") as JSONModel;
        if (!oVM) {
            // Fallback: get model from owner component
            const oOwner = this.getOwnerComponent();
            oVM = oOwner?.getModel("viewModel") as JSONModel;
            if (oVM && oView) {
                oView.setModel(oVM, "viewModel");
            }
        }
        
        if (!oVM) {
            console.error("viewModel not found in Main controller");
            return;
        }
        
        // Check if OData model is available
        let oDataModel = this.getView()?.getModel();
        
        // If not available on view, try to get it from component and set it on view
        if (!oDataModel) {
            const component = this.getOwnerComponent();
            oDataModel = component?.getModel();
            
            if (oDataModel && oView) {
                oView.setModel(oDataModel);
                oDataModel = this.getView()?.getModel();
            }
        }

        // Initialize view model data with proper defaults to prevent undefined errors
        oVM.setData({
            ...oVM.getData(),
            selectedConfigId: null,
            selectedConfigIds: [], // Initialize as empty array to prevent .length errors
            selectedConfigCanActivate: false,
            selectedConfigCanDelete: false,
            selectedConfigIsActive: false, // Track if selected config is active (for read-only editor)
            selectedConfigName: "", // Track selected config name for title
            selectedConfigVersion: "", // Track selected config version for title
            isEditMode: false, // Track if editor is in edit mode
            filters: {
                search: "",
                status: "",
                validation: "",
                name: ""
            },
            newConfig: {
                name: "",
                version: "",
                description: "",
                configData: "{\n  \n}"
            },
            dialogMode: "create", // Track if dialog is in "create" or "duplicate" mode
            dialogTitle: "Create New Configuration",
            rollbackReason: "" // For rollback dialog
        });


        // Add FCL state change listener for debugging
        const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
        if (fcl) {
            fcl.attachStateChange((event: any) => {
                const params = event.getParameters();
                console.log("[FCL] stateChange →", params.layout, "isResize:", params.isResize);
            });
        }

        // Load initial data
        this._loadConfigurations();
    }

    /**
     * Load all configurations
     */
    private _loadConfigurations(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        // Refresh the existing table binding instead of creating a new one
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items");
        
        if (binding) {
            binding.refresh();
            
            // Wait for refresh to complete
            binding.attachEventOnce("dataReceived", () => {
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
            });
            
            binding.attachEventOnce("dataRequested", () => {
                // Handle any errors
            });
        } else {
            // Fallback if no binding exists
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
            MessageToast.show("Unable to refresh configurations");
        }
    }

    /**
     * Handle table selection change
     */
    public onSelectionChange(event: any): void {
        const table = event.getSource() as Table;
        const selectedItems = table.getSelectedItems();
        const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
        
        if (!viewModel) return;

        const selectedConfigIds = selectedItems.map((item: any) => {
            const context = item.getBindingContext();
            return context?.getObject()?.ID;
        }).filter(Boolean);

        viewModel.setProperty("/selectedConfigIds", selectedConfigIds);

        // Update action button states
        if (selectedConfigIds.length === 1) {
            const selectedItem = selectedItems[0];
            const configData = selectedItem.getBindingContext()?.getObject();
            if (configData) {
                viewModel.setProperty("/selectedConfigId", configData.ID);
                viewModel.setProperty("/selectedConfigCanActivate", !configData.isActive && configData.isValid);
                viewModel.setProperty("/selectedConfigCanDelete", !configData.isActive);
                this._selectedConfig = configData;
            }
        } else {
            viewModel.setProperty("/selectedConfigId", null);
            viewModel.setProperty("/selectedConfigCanActivate", false);
            viewModel.setProperty("/selectedConfigCanDelete", selectedConfigIds.length > 0);
            viewModel.setProperty("/selectedConfigIsActive", false);
            this._selectedConfig = null;
        }
    }

    /**
     * Handle item press to show details (for table itemPress event)
     */
    public async onItemPress(event: any): Promise<void> {
        // Check for unsaved changes before navigating
        if (this._hasUnsavedChanges()) {
            const confirmLeave = await this._confirmNavigationWithUnsavedChanges();
            if (!confirmLeave) {
                console.log("Navigation cancelled due to unsaved changes");
                return;
            } else {
                // User accepted data loss - reset dirty state
                console.log("🗑️ User accepted data loss - resetting dirty state");
                this._isEditorDirty = false;
                this._updateDirtyStateUI();
            }
        }
        
        const item = event.getParameter("listItem");
        const bindingContext = item.getBindingContext();
        
        if (!bindingContext) {
            console.error("No binding context found for item");
            return;
        }
        
        const configData = bindingContext.getObject();
        console.log("Item pressed, config data:", configData);
        
        if (configData) {
            try {
                // 1) Resolve the SINGLETON viewModel from the component (never per-view)
                const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
                if (!viewModel) {
                    console.error("ViewModel not found at component level");
                    return;
                }
                
                
                // 2) Optimistically set UI state *first* so visibility gates open
                viewModel.setProperty("/selectedConfigId", configData.ID);
                viewModel.setProperty("/selectedConfigIds", [configData.ID]);
                viewModel.setProperty("/selectedConfigCanActivate", !configData.isActive && configData.isValid);
                viewModel.setProperty("/selectedConfigCanDelete", !configData.isActive);
                viewModel.setProperty("/selectedConfigName", configData.name || "");
                viewModel.setProperty("/selectedConfigVersion", configData.version || "");
                viewModel.setProperty("/isEditMode", false); // Always start in view mode
                viewModel.checkUpdate(true); // Force binding update
                
                // Store selected config
                this._selectedConfig = configData;
                
                // 3) Bind the detail page to the selected row's context (fast path)
                const detailPage = this.byId("detailDynamicPage");
                if (detailPage) {
                    detailPage.setBindingContext(bindingContext);
                    console.log("Detail page binding context set to item context");
                }
                
                // 4) Switch FCL layout (after state + binding are in place)
                const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
                if (fcl) {
                    console.log("Setting FCL layout to TwoColumnsMidExpanded");
                    fcl.setLayout("TwoColumnsMidExpanded");
                }
                
                // 5) Wait for detail page to render after layout switch
                if (detailPage) {
                    console.log("Waiting for detail page to render...");
                    await this._afterRenderingOnce(detailPage as Control);
                    console.log("Detail page rendered");
                }
                
                // 6) Ensure editor is rendered and handle fallbacks
                await this._handleEditorWithRenderTiming(configData.ID);
                
            } catch (error) {
                console.error("Error in onItemPress:", error);
                // Fallback to old approach if timing fails
                this._ensureDetailContentVisible();
                this._createDetailContentIfNeeded();
                this._loadConfigurationDetails(configData.ID);
            }
        }
    }

    /**
     * Handle row press to show details (legacy method, keeping for compatibility)
     */
    public onRowPress(event: any): void {
        const item = event.getSource();
        const bindingContext = item.getBindingContext();
        
        if (!bindingContext) {
            console.error("No binding context found for row");
            return;
        }
        
        const configData = bindingContext.getObject();
        console.log("Row pressed, config data:", configData);
        
        if (configData) {
            // Update selection in view model
            const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
            if (viewModel) {
                viewModel.setProperty("/selectedConfigId", configData.ID);
                viewModel.setProperty("/selectedConfigIds", [configData.ID]);
                viewModel.setProperty("/selectedConfigCanActivate", !configData.isActive && configData.isValid);
                viewModel.setProperty("/selectedConfigCanDelete", !configData.isActive);
            }
            
            // Store selected config
            this._selectedConfig = configData;
            
            // Show detail view
            this._showConfigurationDetail();
        }
    }

    /**
     * Optimize editor height based on available viewport space
     */
    private _optimizeEditorHeight(editor: CodeEditor): void {
        if (!editor || !editor.getDomRef()) return;
        
        try {
            const editorElement = editor.getDomRef();
            const rect = editorElement.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            
            // Calculate optimal height: available space minus buffer
            const availableHeight = viewportHeight - rect.top - 120; // 120px buffer for footer/padding
            const optimalHeight = Math.min(Math.max(availableHeight, 300), 800); // Between 300-800px
            
            console.log(`🎯 Height optimization: viewport=${viewportHeight}px, available=${Math.round(availableHeight)}px, optimal=${Math.round(optimalHeight)}px`);
            
            if (optimalHeight > rect.height + 50) { // Only adjust if meaningful improvement
                editor.setHeight(Math.round(optimalHeight) + "px");
                console.log(`✅ Editor height optimized to ${Math.round(optimalHeight)}px`);
            } else {
                console.log(`ℹ️ Current height (${Math.round(rect.height)}px) is already optimal`);
            }
        } catch (error) {
            console.warn("Error optimizing editor height:", error);
        }
    }

    /**
     * Handle editor with proper render timing coordination
     */
    private async _handleEditorWithRenderTiming(configId: string): Promise<void> {
        console.log("Handling editor with render timing...");
        
        // Super fast path: If we already have a working programmatic editor, use it immediately!
        if (this._programmaticEditor && 
            this._programmaticEditor.getDomRef && 
            this._programmaticEditor.getValue) {
            console.log("⚡ Using existing programmatic editor - skipping all setup!");
            this._loadConfigurationDetails(configId);
            return;
        }
        
        // Try original editor (but don't wait too long)
        let editor = this.byId("jsonEditor") as CodeEditor;
        
        if (editor) {
            console.log("Found original JSON editor, quick render check...");
            console.log("Editor current DOM state:", editor.getDomRef() ? "has DOM" : "no DOM");
            
            try {
                // Much shorter timeout for original editor (500ms instead of 2000ms)
                const renderPromise = this._afterRenderingOnce(editor as Control);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error("Quick render timeout")), 500)
                );
                
                await Promise.race([renderPromise, timeoutPromise]);
                console.log("⚡ Original editor rendered quickly!");
                
                // Load data immediately
                this._loadConfigurationDetails(configId);
                return;
                
            } catch (error) {
                console.log("Original editor not ready quickly, creating programmatic...");
            }
        }
        
        // Fast fallback: create programmatic editor
        console.log("Creating programmatic editor for fast loading...");
        this._ensureDetailContentVisible();
        await this._createDetailContentIfNeeded();
        
        // Load data immediately after creation
        console.log("⚡ Loading data with programmatic editor...");
        this._loadConfigurationDetails(configId);
    }

    /**
     * Programmatically ensure the detail content VBox is visible
     * Simple approach: Just force all VBoxes in detail page visible
     */
    private _ensureDetailContentVisible(): void {
        console.log("Unconditionally showing detail content VBox...");
        
        try {
            const detailPage = this.byId("detailDynamicPage");
            if (!detailPage) {
                console.error("Detail page not found");
                return;
            }
            
            // Simple approach: Find ALL VBox controls and make them visible
            const allControls = detailPage.findAggregatedObjects(true);
            let vboxCount = 0;
            
            for (const control of allControls) {
                if (control.getMetadata && 
                    control.getMetadata().getName() === "sap.m.VBox") {
                    
                    console.log(`Found VBox ${vboxCount}: ${control.getId()} - currently visible: ${control.getVisible()}`);
                    
                    // Unconditionally set visible
                    control.setVisible(true);
                    vboxCount++;
                    
                    console.log(`VBox ${vboxCount-1} set to visible`);
                }
            }
            
            console.log(`Total VBoxes processed: ${vboxCount}`);
            
            // Also force visibility on the detail page content itself
            const content = detailPage.getContent();
            if (content && content.length > 0) {
                content.forEach((item: any, i: number) => {
                    if (item.setVisible) {
                        console.log(`Setting content item ${i} visible`);
                        item.setVisible(true);
                    }
                });
            }
            
        } catch (error) {
            console.error("Error ensuring detail content visibility:", error);
        }
    }

    /**
     * Create detail content programmatically if binding failed
     * This bypasses the binding system entirely
     */
    private async _createDetailContentIfNeeded(): Promise<void> {
        console.log("Checking if detail content needs to be created programmatically...");
        
        try {
            // If we already have a working programmatic editor, reuse it!
            if (this._programmaticEditor && 
                this._programmaticEditor.getDomRef && 
                this._programmaticEditor.getValue) {
                console.log("⚡ Reusing existing programmatic editor - no creation needed!");
                return;
            }
            
            const detailPage = this.byId("detailDynamicPage");
            if (!detailPage) {
                console.error("Detail page not found");
                return;
            }
            
            // Clean up any existing programmatic editor first to avoid duplicate IDs
            this._cleanupProgrammaticEditor();
            
            // Check if our target VBox exists (the one with JSON editor)
            const content = detailPage.getContent();
            let hasMainContentVBox = false;
            
            if (content && content.length > 0) {
                for (const item of content) {
                    if (item.hasStyleClass && item.hasStyleClass("sapUiMediumMargin")) {
                        hasMainContentVBox = true;
                        console.log("Main content VBox already exists");
                        break;
                    }
                }
            }
            
            if (!hasMainContentVBox) {
                console.log("Main content VBox missing - creating programmatically...");
                await this._createDetailContentProgrammatically();
            } else {
                console.log("Main content VBox exists - no need to create");
            }
            
        } catch (error) {
            console.error("Error checking detail content:", error);
        }
    }

    /**
     * Clean up existing programmatic editor to avoid duplicate IDs
     */
    private _cleanupProgrammaticEditor(): void {
        if (this._programmaticEditor) {
            console.log("🧹 Cleaning up existing programmatic editor");
            try {
                // Destroy the UI5 control properly
                this._programmaticEditor.destroy();
            } catch (error) {
                console.warn("Error destroying programmatic editor:", error);
            }
            this._programmaticEditor = null;
        }
    }

    /**
     * Programmatically create the detail content VBox and JSON editor
     */
    private async _createDetailContentProgrammatically(): Promise<void> {
        console.log("Creating detail content programmatically...");
        
        try {
            const detailPage = this.byId("detailDynamicPage");
            if (!detailPage) return;
            
            // Import required UI5 controls
            const VBox = sap.ui.require("sap/m/VBox");
            const Panel = sap.ui.require("sap/m/Panel");
            const CodeEditor = sap.ui.require("sap/ui/codeeditor/CodeEditor");
            const Text = sap.ui.require("sap/m/Text");
            
            if (!VBox || !Panel || !CodeEditor || !Text) {
                console.error("Required UI5 controls not available");
                return;
            }
            
            // Create the programmatic JSON editor and store direct reference
            // Check if config is active to determine editable state
            const isConfigActive = this._selectedConfig?.isActive || false;
            const programmaticEditor = new CodeEditor("programmaticJsonEditor", {
                type: "json",
                height: "70vh", // Optimized height for good balance
                width: "100%", 
                editable: !isConfigActive // Read-only if active
                // No value binding - we'll set it programmatically to avoid Raw type
            });
            
            console.log(`🔒 Programmatic editor created with editable=${!isConfigActive} (config active: ${isConfigActive})`);
            
            // Store direct reference for ultra-fast access
            this._programmaticEditor = programmaticEditor;
            console.log("🚀 Stored direct reference to programmatic editor");
            
            // Create main content VBox with optimized sizing
            const mainVBox = new VBox({
                visible: true,
                items: [
                    new Panel({
                        headerText: "Configuration Data (JSON)",
                        expandable: true,
                        expanded: true,
                        content: [programmaticEditor]
                    })
                ]
            });
            
            // Add optimized CSS classes for better width utilization
            mainVBox.addStyleClass("sapUiSmallMargin"); // Reduced from Medium to Small margin
            
            // Make the panel use full width
            const panel = mainVBox.getItems()[0]; // Now first item since we removed the Text
            panel.addStyleClass("sapUiNoContentPadding"); // Remove panel content padding
            
            console.log("Created main VBox with JSON editor");
            
            // Add to existing DynamicPage content structure instead of replacing it
            console.log("Adding programmatic content to existing structure...");
            console.log("Detail page type:", detailPage.getMetadata().getName());
            
            const existingContent = detailPage.getContent();
            console.log("Existing content:", existingContent);
            
            if (existingContent && existingContent.length > 0) {
                // Find the main VBox in existing content (the one with selectedConfigId visibility)
                const existingVBox = existingContent[0]; // Should be the main VBox
                console.log("Found existing VBox:", existingVBox.getMetadata().getName());
                
                if (existingVBox && existingVBox.addItem) {
                    console.log("Adding programmatic content to existing VBox...");
                    existingVBox.addItem(mainVBox.getItems()[1]); // Add just the Panel with JSON editor
                    console.log("✓ Added programmatic Panel to existing VBox");
                } else {
                    console.log("Existing VBox doesn't support addItem, trying alternative...");
                    // Get existing VBox items and add our content
                    const existingItems = existingVBox.getItems ? existingVBox.getItems() : [];
                    console.log("Existing VBox has", existingItems.length, "items");
                    
                    if (existingVBox.insertItem) {
                        existingVBox.insertItem(mainVBox.getItems()[1], existingItems.length);
                        console.log("✓ Inserted programmatic Panel into existing VBox");
                    }
                }
            } else {
                console.log("No existing content found, using setContent as fallback");
                detailPage.setContent(mainVBox);
            }
            
            // Verify content was added
            const finalContent = detailPage.getContent();
            if (finalContent && finalContent.length > 0) {
                const mainVBox = finalContent[0];
                const items = mainVBox.getItems ? mainVBox.getItems() : [];
                console.log("Final VBox items count:", items.length);
            }
            
            console.log("Added main VBox to detail page");
            
            // Force immediate rendering of the main VBox and its contents
            console.log("Forcing immediate render of programmatic content...");
            mainVBox.rerender();
            
            // Force UI5 to apply changes immediately
            sap.ui.getCore().applyChanges();
            
            // Force rendering and look for the programmatic editor
            sap.ui.getCore().applyChanges();
            
            // Wait a moment for the structure to settle, then look for the editor
            setTimeout(async () => {
                // First try byId approach
                let progEditor = this.byId("programmaticJsonEditor") as CodeEditor;
                
                if (!progEditor) {
                    console.log("byId failed, searching in all controls...");
                    // Find the editor by searching all controls
                    const allControls = detailPage.findAggregatedObjects(true);
                    console.log("All controls in detail page:", allControls.map(c => c.getId()));
                    
                    progEditor = allControls.find(c => c.getId() === "programmaticJsonEditor") as CodeEditor;
                    if (!progEditor) {
                        // Try finding by ID ending
                        progEditor = allControls.find(c => c.getId().endsWith("programmaticJsonEditor")) as CodeEditor;
                    }
                }
                
                if (progEditor) {
                    console.log("✅ Found programmatic editor via search!");
                    console.log("Editor ID:", progEditor.getId());
                    console.log("Editor DOM state:", progEditor.getDomRef() ? "has DOM" : "no DOM");
                    console.log("Editor visible:", progEditor.getVisible());
                    
                    try {
                        // Add timeout for programmatic editor too
                        const renderPromise = this._afterRenderingOnce(progEditor as Control);
                        const timeoutPromise = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error("Programmatic render timeout")), 1500)
                        );
                        
                        await Promise.race([renderPromise, timeoutPromise]);
                        console.log("✅ Programmatic editor rendered successfully");
                        
                        // Force proper sizing and optimize height
                        if (progEditor.getDomRef()) {
                            progEditor.rerender();
                            console.log("✅ Programmatic editor rerendered for sizing");
                            
                            // Optimize height based on available space
                            setTimeout(() => {
                                this._optimizeEditorHeight(progEditor);
                            }, 100);
                        }
                    } catch (error) {
                        console.warn("⚠️ Programmatic editor render failed:", error);
                        console.log("Programmatic editor DOM after timeout:", progEditor.getDomRef() ? "has DOM" : "no DOM");
                        
                        // Force render one more time
                        console.log("Forcing final render attempt...");
                        progEditor.invalidate();
                        sap.ui.getCore().applyChanges();
                        
                        // Check again after force
                        setTimeout(() => {
                            console.log("Final DOM check:", progEditor.getDomRef() ? "has DOM" : "no DOM");
                        }, 100);
                    }
                } else {
                    console.error("❌ Could not find programmatic editor even with search!");
                }
            }, 100);
            
        } catch (error) {
            console.error("Error creating detail content programmatically:", error);
        }
    }

    /**
     * Load additional configuration details (async data loading)
     */
    private _loadConfigurationDetails(configId: string): void {
        // Load expanded configData for the JSON editor
        const oModel = this.getView()?.getModel() as ODataModel;
        const configContext = oModel.bindContext(`/ApiConfigurations(ID='${configId}')`);
        
        configContext.requestObject().then((fullConfig: any) => {
            console.log("Full config loaded:", fullConfig);
            
            // Store the full config for other operations
            this._selectedConfig = fullConfig;
            
            // Update view model with active status and metadata for UI binding
            const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
            if (viewModel) {
                viewModel.setProperty("/selectedConfigIsActive", fullConfig.isActive);
                viewModel.setProperty("/selectedConfigName", fullConfig.name || "");
                viewModel.setProperty("/selectedConfigVersion", fullConfig.version || "");
                console.log(`🔒 Configuration active status: ${fullConfig.isActive ? 'ACTIVE (Read-Only)' : 'INACTIVE (Editable)'}`);
            }
            
            // Set JSON editor content - try both original and programmatic editor
            if (fullConfig.configData) {
                try {
                    const formatted = JSON.stringify(JSON.parse(fullConfig.configData), null, 2);
                    
                    // Check which editor is actually rendered and usable
                    let editor = this.byId("programmaticJsonEditor") as CodeEditor;
                    let editorType = "programmatic";
                    
                    // If byId fails, search for programmatic editor
                    if (!editor) {
                        console.log("byId failed for programmatic editor, searching...");
                        const detailPage = this.byId("detailDynamicPage");
                        if (detailPage) {
                            const allControls = detailPage.findAggregatedObjects(true);
                            editor = allControls.find(c => 
                                c.getId() === "programmaticJsonEditor" || 
                                c.getId().endsWith("programmaticJsonEditor")
                            ) as CodeEditor;
                            
                            if (editor) {
                                console.log("✅ Found programmatic editor via search for data loading!");
                                console.log("Editor ID:", editor.getId());
                            }
                        }
                    }
                    
                    // If programmatic editor exists and has DOM, use it
                    if (editor && editor.getDomRef()) {
                        console.log("Using programmatic editor (has DOM)");
                    } else if (editor) {
                        console.log("Programmatic editor exists but no DOM, trying to render...");
                        editor.rerender();
                        sap.ui.getCore().applyChanges();
                    } else {
                        // Fallback to original editor only if programmatic doesn't exist
                        editor = this.byId("jsonEditor") as CodeEditor;
                        editorType = "original";
                        console.log("No programmatic editor found, trying original");
                    }
                    
                    if (editor) {
                        console.log(`Using ${editorType} JSON editor:`, !!editor);
                        console.log("Editor ready state:", editor.getDomRef() ? "rendered" : "not rendered");
                        
                        // Use more aggressive approach to set value
                        const setValue = () => {
                            if (editor.getDomRef()) {
                                console.log("Setting JSON editor value (formatted)");
                                editor.setValue(formatted);
                                
                                // Always start editor in read-only mode (edit button will enable editing)
                                editor.setEditable(false);
                                console.log(`🔒 Editor started in read-only mode`);
                                
                                console.log("JSON value set successfully");
                                
                                // Set up dirty state tracking (will be activated when edit mode is enabled)
                                this._setupDirtyStateTracking(editor, formatted);
                                return true;
                            }
                            return false;
                        };
                        
                        // Try immediate set
                        if (!setValue()) {
                            console.log("Editor not rendered, trying multiple approaches...");
                            
                            // Force render and try again
                            editor.invalidate();
                            sap.ui.getCore().applyChanges();
                            
                            // Try after short delay
                            setTimeout(() => {
                                if (!setValue()) {
                                    // Force rerender and try once more
                                    editor.rerender();
                                    setTimeout(() => {
                                        if (setValue()) {
                                            console.log("JSON value set after rerender");
                                            // Dirty state tracking already set up in setValue()
                                        } else {
                                            console.warn("Failed to set JSON value - editor never rendered");
                                        }
                                    }, 50);
                                }
                            }, 100);
                        }
                    } else {
                        console.warn("No JSON editor found (neither original nor programmatic)");
                    }
                } catch (e) {
                    console.log("JSON parse error, setting raw value");
                    
                    let editor = this.byId("jsonEditor") as CodeEditor;
                    if (!editor) {
                        editor = this.byId("programmaticJsonEditor") as CodeEditor;
                    }
                    
                    if (editor) {
                        if (editor.getDomRef()) {
                            editor.setValue(fullConfig.configData);
                        } else {
                            setTimeout(() => {
                                if (editor.getDomRef()) {
                                    editor.setValue(fullConfig.configData);
                                }
                            }, 100);
                        }
                    }
                }
            } else {
                console.log("No configData field, setting placeholder");
                
                let editor = this.byId("jsonEditor") as CodeEditor;
                if (!editor) {
                    editor = this.byId("programmaticJsonEditor") as CodeEditor;
                }
                
                if (editor) {
                    const placeholder = "{\n  \"// Configuration data not available\": true,\n  \"configId\": \"" + configId + "\"\n}";
                    if (editor.getDomRef()) {
                        editor.setValue(placeholder);
                    } else {
                        setTimeout(() => {
                            if (editor.getDomRef()) {
                                editor.setValue(placeholder);
                            }
                        }, 100);
                    }
                }
            }
        }).catch((error: any) => {
            console.error("Error loading full config:", error);
            const editor = this.byId("jsonEditor") as CodeEditor;
            if (editor) {
                editor.setValue("{\n  \"// Error loading configuration\": true,\n  \"error\": \"" + error.message + "\"\n}");
            }
        });
    }

    /**
     * Show configuration detail in FCL (legacy method - now simplified)
     */
    private _showConfigurationDetail(): void {
        // Legacy method - functionality moved to onItemPress with proper sequence
        console.log("_showConfigurationDetail called - this should now be handled by onItemPress");
    }

    /**
     * Close detail view
     */
    public async onCloseDetail(): Promise<void> {
        // Check for unsaved changes before closing
        if (this._hasUnsavedChanges()) {
            const confirmLeave = await this._confirmNavigationWithUnsavedChanges();
            if (!confirmLeave) {
                console.log("Close detail cancelled due to unsaved changes");
                return;
            } else {
                // User accepted data loss - reset dirty state
                console.log("🗑️ User accepted data loss - resetting dirty state");
                this._isEditorDirty = false;
                this._updateDirtyStateUI();
            }
        }
        
        const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
        if (fcl) {
            fcl.setLayout("OneColumn");
        }

        // Clear binding context from detail page
        const detailPage = this.byId("detailDynamicPage");
        if (detailPage) {
            detailPage.setBindingContext(null);
        }

        // Clear selection
        const table = this.byId("configTable") as Table;
        table.removeSelections();
        
        const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/selectedConfigId", null);
            viewModel.setProperty("/selectedConfigIds", []);
            viewModel.setProperty("/selectedConfigCanActivate", false);
            viewModel.setProperty("/selectedConfigCanDelete", false);
            viewModel.setProperty("/selectedConfigIsActive", false);
            viewModel.setProperty("/selectedConfigName", "");
            viewModel.setProperty("/selectedConfigVersion", "");
            viewModel.setProperty("/isEditMode", false);
            viewModel.checkUpdate(true);
        }
        
        
        this._selectedConfig = null;
        
        // Clean up programmatic editor properly
        this._cleanupProgrammaticEditor();
    }

    /**
     * Handle search from MDC FilterBar
     */
    public onSearch(event: any): void {
        console.log("📍 MDC FilterBar search triggered");
        this._applyFilters();
    }
    
    /**
     * Handle search field search event (Enter key)
     */
    public onSearchFieldSearch(event: any): void {
        console.log("📍 SearchField search event (Enter key pressed)");
        const query = event.getParameter("query") || event.getSource().getValue();
        console.log("Search query:", query);
        
        // Update viewModel with search value
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/filters/search", query);
        }
        
        // Auto-trigger search
        this._applyFilters();
    }
    
    /**
     * Handle search field live change (update model only, no auto-trigger)
     */
    public onSearchFieldLiveChange(event: any): void {
        const query = event.getParameter("newValue");
        console.log("📍 SearchField live change:", query);
        
        // Update viewModel with search value but don't auto-apply
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/filters/search", query);
        }
    }

    /**
     * Handle filter change (no auto-apply, wait for Go button)
     */
    public onFilterChange(event: any): void {
        console.log("🔍 Filter changed, waiting for Go button...");
        // Just log the change, don't auto-apply
    }
    
    /**
     * Apply filters when Go button is pressed
     */
    public onApplyFilters(): void {
        console.log("🔍 Go button pressed, applying filters...");
        this._applyFilters();
    }


    /**
     * Clear all filters (MDC FilterBar clear event)
     */
    public onClearFilters(): void {
        console.log("🧹 Clearing all filters");
        
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/filters", {
                search: "",
                status: "",
                validation: "",
                name: ""
            });
        }

        // Clear search field directly
        const searchField = this.byId("searchField");
        if (searchField) {
            (searchField as any).setValue("");
        }
        
        // Clear other filter controls
        const statusFilter = this.byId("statusFilter");
        if (statusFilter) {
            (statusFilter as any).setSelectedKey("");
        }
        
        const validationFilter = this.byId("validationFilter");
        if (validationFilter) {
            (validationFilter as any).setSelectedKey("");
        }
        
        const nameFilter = this.byId("nameFilter");
        if (nameFilter) {
            (nameFilter as any).setValue("");
        }

        // Auto-apply cleared filters
        this._applyFilters();
    }
    

    /**
     * Apply all active filters with modern auto-trigger approach
     */
    private _applyFilters(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const filters = viewModel?.getProperty("/filters") || {};
        
        console.log("🔍 Applying filters:", filters);
        
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items");
        
        if (binding) {
            const filterArray: Filter[] = [];
            
            // Search filter - use value from viewModel
            const searchQuery = filters.search || "";
            if (searchQuery.trim()) {
                const searchFilters = [
                    new Filter("name", FilterOperator.Contains, searchQuery),
                    new Filter("description", FilterOperator.Contains, searchQuery),
                    new Filter("version", FilterOperator.Contains, searchQuery)
                ];
                filterArray.push(new Filter(searchFilters, false)); // OR logic
                console.log("🔍 Applied search filter:", searchQuery);
            }
            
            // Status filter
            if (filters.status === "active") {
                filterArray.push(new Filter("isActive", FilterOperator.EQ, true));
                console.log("🔍 Applied status filter: active");
            } else if (filters.status === "inactive") {
                filterArray.push(new Filter("isActive", FilterOperator.EQ, false));
                console.log("🔍 Applied status filter: inactive");
            }
            
            // Validation filter
            if (filters.validation === "valid") {
                filterArray.push(new Filter("isValid", FilterOperator.EQ, true));
                console.log("🔍 Applied validation filter: valid");
            } else if (filters.validation === "invalid") {
                filterArray.push(new Filter("isValid", FilterOperator.EQ, false));
                console.log("🔍 Applied validation filter: invalid");
            }
            
            // Name filter
            if (filters.name?.trim()) {
                filterArray.push(new Filter("name", FilterOperator.Contains, filters.name));
                console.log("🔍 Applied name filter:", filters.name);
            }
            
            binding.filter(filterArray);
            console.log("✅ Filters applied successfully, count:", filterArray.length);
            
            // Refresh binding after applying filters to ensure fresh data
            binding.refresh();
        }
    }

    /**
     * Refresh configurations
     */
    public onRefresh(): void {
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items");
        if (binding) {
            binding.refresh();
        }
        MessageToast.show("Configurations refreshed");
    }

    /**
     * Open new configuration dialog
     */
    public onNewConfiguration(): void {
        const dialog = this.byId("createConfigDialog") as Dialog;
        
        // Reset form and set create mode
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/dialogMode", "create");
            viewModel.setProperty("/dialogTitle", "Create New Configuration");
            viewModel.setProperty("/newConfig", {
                name: "",
                version: "",
                description: "",
                configData: "{\n  \n}"
            });
        }
        
        dialog.open();
        
        // Trigger CodeEditor resize after dialog opens with dynamic height calculation
        setTimeout(() => {
            this._setDynamicEditorHeight("newConfigEditor");
            this._setupDialogResizeHandler("newConfigEditor");
        }, 100);
    }

    /**
     * Create new configuration
     */
    public onCreateConfiguration(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const newConfig = viewModel?.getProperty("/newConfig");
        
        // Validate required fields
        if (!newConfig?.name || !newConfig?.version || !newConfig?.configData) {
            MessageBox.error("Please fill in all required fields");
            return;
        }

        // Validate JSON syntax
        try {
            JSON.parse(newConfig.configData);
        } catch (e) {
            MessageBox.error("Invalid JSON in configuration data");
            return;
        }

        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        const oModel = this.getView()?.getModel() as ODataModel;
        let createBinding: any = null;

        // First validate the configuration data using backend validation
        const validateBinding = oModel.bindContext("/validateConfiguration(...)");
        validateBinding.setParameter("configData", newConfig.configData);

        validateBinding.execute().then(() => {
            const validationResult = validateBinding.getBoundContext()?.getObject();
            
            if (!validationResult?.valid) {
                let message = "Configuration validation failed";
                if (validationResult?.errors?.length) {
                    message += ":\n" + validationResult.errors.join("\n");
                }
                MessageBox.error(message);
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
                return Promise.reject(new Error("Validation failed"));
            }

            // If validation passes, proceed with creation
            createBinding = oModel.bindContext("/createConfiguration(...)");
            
            createBinding.setParameter("name", newConfig.name);
            createBinding.setParameter("configData", newConfig.configData);
            createBinding.setParameter("description", newConfig.description);

            return createBinding.execute();
        }).then(() => {
            // Get the result from the create binding
            const createResult = createBinding?.getBoundContext()?.getObject();
            
            if (createResult?.success) {
                MessageToast.show("Configuration created successfully");
                this.onCancelCreateConfiguration(); // This will clean up resize handler
                this._loadConfigurations();
            } else {
                MessageBox.error("Failed to create configuration: " + (createResult?.errors?.join(", ") || "Unknown error"));
            }
        }).catch((error: Error) => {
            if (error.message !== "Validation failed") {
                MessageBox.error("Error creating configuration: " + error.message);
            }
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Cancel create configuration
     */
    public onCancelCreateConfiguration(): void {
        const dialog = this.byId("createConfigDialog") as Dialog;
        dialog.close();
        
        // Clean up resize handler when dialog closes
        this._cleanupDialogResizeHandler();
    }

    /**
     * Set up dirty state tracking for an editor
     */
    private _setupDirtyStateTracking(editor: CodeEditor, initialValue: string): void {
        if (!editor) return;
        
        console.log("🔍 Setting up dirty state tracking for editor:", editor.getId());
        this._originalEditorValue = initialValue;
        this._isEditorDirty = false;
        
        // Remove any existing change handlers to avoid duplicates
        editor.detachChange(this._onEditorChange, this);
        
        // Attach change handler
        editor.attachChange(this._onEditorChange, this);
        
        console.log("✅ Dirty state tracking enabled");
    }
    
    /**
     * Handle editor change events for dirty state tracking
     */
    private _onEditorChange(): void {
        const editor = this._getActiveEditor();
        if (!editor) return;
        
        const currentValue = editor.getValue();
        const wasDirty = this._isEditorDirty;
        this._isEditorDirty = currentValue !== this._originalEditorValue;
        
        if (wasDirty !== this._isEditorDirty) {
            console.log(`📝 Editor dirty state changed: ${this._isEditorDirty ? 'DIRTY' : 'CLEAN'}`);
            
            // Update UI to show dirty state (could add * to title, etc.)
            this._updateDirtyStateUI();
        }
    }
    
    /**
     * Update UI to reflect dirty state
     */
    private _updateDirtyStateUI(): void {
        // Could add visual indicators here, like:
        // - Adding asterisk (*) to configuration name
        // - Changing save button appearance
        // - Adding warning colors
        
        console.log(`🎨 UI dirty state: ${this._isEditorDirty ? 'Modified' : 'Saved'}`);
    }
    
    /**
     * Check if editor has unsaved changes
     */
    private _hasUnsavedChanges(): boolean {
        return this._isEditorDirty;
    }
    
    /**
     * Reset dirty state (call after successful save)
     */
    private _resetDirtyState(): void {
        const editor = this._getActiveEditor();
        if (editor) {
            this._originalEditorValue = editor.getValue();
            this._isEditorDirty = false;
            this._updateDirtyStateUI();
            console.log("✅ Dirty state reset after save");
        }
    }
    
    /**
     * Show confirmation dialog for navigation with unsaved changes
     */
    private _confirmNavigationWithUnsavedChanges(): Promise<boolean> {
        return new Promise((resolve) => {
            MessageBox.confirm(
                "You have unsaved changes to the configuration.\n\nDo you want to leave without saving? Your changes will be lost.",
                {
                    title: "Unsaved Changes",
                    actions: [MessageBox.Action.YES, MessageBox.Action.CANCEL],
                    emphasizedAction: MessageBox.Action.CANCEL,
                    onClose: (action: string) => {
                        resolve(action === MessageBox.Action.YES);
                    }
                }
            );
        });
    }

    /**
     * Get the active editor (original or programmatic) - super fast with direct references
     */
    private _getActiveEditor(): CodeEditor | null {
        // Ultra-fast path: Use direct reference to programmatic editor if available
        if (this._programmaticEditor && 
            this._programmaticEditor.getDomRef && 
            this._programmaticEditor.getValue) {
            return this._programmaticEditor;
        }
        
        // Fast path: Try original editor via byId
        const originalEditor = this.byId("jsonEditor") as CodeEditor;
        if (originalEditor && originalEditor.getDomRef && originalEditor.getValue) {
            return originalEditor;
        }
        
        console.error("❌ No usable editor found");
        return null;
    }

    /**
     * Validate configuration
     */
    public onValidateConfiguration(): void {
        if (!this._selectedConfig) {
            return;
        }

        const editor = this._getActiveEditor();
        if (!editor) {
            MessageBox.error("Editor not available for validation");
            return;
        }
        
        const configData = editor.getValue();

        // Validate JSON syntax first
        try {
            JSON.parse(configData);
        } catch (e) {
            MessageBox.error("Invalid JSON syntax");
            return;
        }

        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        // Call validateConfiguration action
        const oModel = this.getView()?.getModel() as ODataModel;
        const actionBinding = oModel.bindContext("/validateConfiguration(...)");
        
        actionBinding.setParameter("configData", configData);

        actionBinding.execute().then(() => {
            const result = actionBinding.getBoundContext()?.getObject();
            if (result?.valid) {
                MessageToast.show("Configuration is valid");
            } else {
                let message = "Configuration validation failed";
                if (result?.errors?.length) {
                    message += ":\n" + result.errors.join("\n");
                }
                MessageBox.error(message);
            }
        }).catch((error: Error) => {
            MessageBox.error("Error validating configuration: " + error.message);
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Save configuration changes with automatic validation
     */
    public onSaveConfiguration(): void {
        if (!this._selectedConfig) {
            return;
        }

        // Prevent saving active configurations
        if (this._selectedConfig.isActive) {
            MessageBox.error("Cannot save active configuration. Please deactivate it first to make changes.");
            return;
        }

        const editor = this._getActiveEditor();
        if (!editor) {
            MessageBox.error("Editor not available for saving");
            return;
        }
        
        const configData = editor.getValue();
        
        // Check if any changes were made
        console.log("🔍 Checking for changes...");
        console.log("Current config data length:", configData.length);
        console.log("Original config data length:", this._originalEditorValue?.length || 0);
        
        if (configData === this._originalEditorValue) {
            MessageToast.show("No changes detected - configuration not saved");
            console.log("💡 Save skipped - no changes detected (exact match)");
            return;
        }
        
        // Also check normalized JSON to handle formatting differences
        try {
            const currentNormalized = JSON.stringify(JSON.parse(configData));
            const originalNormalized = this._originalEditorValue ? JSON.stringify(JSON.parse(this._originalEditorValue)) : "";
            
            if (currentNormalized === originalNormalized) {
                MessageToast.show("No changes detected - configuration not saved");
                console.log("💡 Save skipped - no changes detected (normalized match)");
                return;
            }
        } catch (e) {
            console.log("📝 JSON normalization failed, proceeding with string comparison");
        }

        // Validate JSON syntax
        try {
            JSON.parse(configData);
        } catch (e) {
            MessageBox.error("Invalid JSON syntax - cannot save");
            return;
        }

        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }
        
        // Auto-validate before saving
        console.log("🔍 Auto-validating configuration before save...");
        this._validateBeforeSave(configData, viewModel);
    }
    
    /**
     * Validate configuration before saving
     */
    private _validateBeforeSave(configData: string, viewModel: JSONModel | null): void {
        const oModel = this.getView()?.getModel() as ODataModel;
        const validateBinding = oModel.bindContext("/validateConfiguration(...)");
        validateBinding.setParameter("configData", configData);

        validateBinding.execute().then(() => {
            const validationResult = validateBinding.getBoundContext()?.getObject();
            
            if (!validationResult?.valid) {
                // Validation failed - show error and don't save
                let message = "Configuration validation failed - cannot save";
                if (validationResult?.errors?.length) {
                    message += ":\n" + validationResult.errors.join("\n");
                }
                MessageBox.error(message);
                
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
                return;
            }
            
            // Validation passed - proceed with save
            console.log("✅ Validation passed, proceeding with save...");
            this._proceedWithSave(configData, viewModel);
            
        }).catch((error: Error) => {
            console.error("❌ Validation error:", error);
            MessageBox.error("Validation failed: " + error.message + "\n\nCannot save configuration.");
            
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }
    
    /**
     * Proceed with save after validation passes
     */
    private _proceedWithSave(configData: string, viewModel: JSONModel | null): void {
        // Update the configuration via OData V4 action or direct PATCH
        const oModel = this.getView()?.getModel() as ODataModel;
        
        try {
            console.log("📝 Attempting to save configuration:", this._selectedConfig.ID);
            
            // Use direct property update (updateConfiguration action not available in service)
            console.log("Using direct property update");
            this._saveViaDirectUpdate(oModel, configData, viewModel);
        } catch (error) {
            console.error("❌ Save setup error:", error);
            MessageBox.error("Error setting up save operation: " + (error as Error).message);
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        }
    }

    /**
     * Fallback method to save via direct property update
     */
    private _saveViaDirectUpdate(oModel: ODataModel, configData: string, viewModel: JSONModel | null): void {
        console.log("Attempting direct property update...");
        
        // Use the existing binding context from the detail page if available
        const detailPage = this.byId("detailDynamicPage");
        let context = detailPage?.getBindingContext();
        
        if (!context) {
            // Create a new binding context
            console.log("Creating new binding context for save");
            const bindingContext = oModel.bindContext(`/ApiConfigurations(ID='${this._selectedConfig.ID}')`);
            
            bindingContext.requestObject().then(() => {
                const boundContext = bindingContext.getBoundContext();
                if (boundContext) {
                    this._updateContextProperty(boundContext, configData, oModel, viewModel);
                } else {
                    throw new Error("Failed to get bound context");
                }
            }).catch((error: Error) => {
                console.error("❌ Direct update failed:", error);
                MessageBox.error("Failed to save configuration: " + error.message);
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
            });
        } else {
            // Use existing context
            console.log("Using existing binding context for save");
            this._updateContextProperty(context, configData, oModel, viewModel);
        }
    }
    
    /**
     * Update the context property and submit changes
     */
    private _updateContextProperty(context: any, configData: string, oModel: ODataModel, viewModel: JSONModel | null): void {
        try {
            console.log("Setting configData property on context");
            
            // Try different ways to set the property
            if (context.setProperty) {
                context.setProperty("configData", configData);
            } else if (context.getObject) {
                const obj = context.getObject();
                obj.configData = configData;
            } else {
                throw new Error("Unable to set property on context");
            }
            
            console.log("✅ Property set, submitting batch...");
            
            // Submit the changes
            oModel.submitBatch(oModel.getUpdateGroupId()).then(() => {
                console.log("✅ Direct save completed successfully");
                MessageToast.show("Configuration saved successfully");
                this._resetDirtyState();
                this._loadConfigurations();
            }).catch((error: Error) => {
                console.error("❌ Batch submit error:", error);
                MessageBox.error("Failed to submit changes: " + error.message);
            }).finally(() => {
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
            });
            
        } catch (error) {
            console.error("❌ Property update error:", error);
            MessageBox.error("Failed to update property: " + (error as Error).message);
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        }
    }

    /**
     * Activate configuration
     */
    public onActivateConfiguration(): void {
        if (!this._selectedConfig) {
            MessageBox.error("Please select a configuration to activate");
            return;
        }

        const config = this._selectedConfig;
        const confirmText = `Activate configuration "${config.name}" version ${config.version}?\n\nThis will set it as the active configuration for the system.\n\nPlease note: The Gateway service will restart with the new configuration, \nany active connections will be interrupted, and if the configuration contains \nerrors, the Gateway service may become unavailable.`;
        
        MessageBox.confirm(confirmText, {
            onClose: (action: string) => {
                if (action === MessageBox.Action.OK) {
                    this._activateConfiguration(config.ID);
                }
            }
        });
    }

    /**
     * Internal method to activate configuration
     */
    private _activateConfiguration(configId: string): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        const oModel = this.getView()?.getModel() as ODataModel;
        const actionBinding = oModel.bindContext("/activateConfiguration(...)");
        
        actionBinding.setParameter("configId", configId);

        actionBinding.execute().then(() => {
            const result = actionBinding.getBoundContext()?.getObject();
            if (result?.success) {
                MessageToast.show("Configuration activated successfully");
                this._loadConfigurations();
            } else {
                MessageBox.error("Failed to activate configuration: " + (result?.error || "Unknown error"));
            }
        }).catch((error: Error) => {
            MessageBox.error("Error activating configuration: " + error.message);
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Duplicate configuration
     */
    public onDuplicateConfiguration(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const selectedConfigIds = viewModel?.getProperty("/selectedConfigIds") || [];
        
        if (selectedConfigIds.length !== 1) {
            MessageBox.error("Please select exactly one configuration to duplicate");
            return;
        }

        const selectedConfigId = selectedConfigIds[0];
        
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        // Always fetch the complete configuration data from the server
        const oModel = this.getView()?.getModel() as ODataModel;
        const configContext = oModel.bindContext(`/ApiConfigurations(ID='${selectedConfigId}')`);
        
        configContext.requestObject().then((fullConfig: any) => {
            console.log("Full config loaded for duplication:", fullConfig);
            
            // Get configData, either from editor (if detail view is open) or from server
            let configData = fullConfig.configData || "{}";
            
            // If detail view is open and editor has content, prefer the editor content
            const editor = this.byId("jsonEditor") as CodeEditor;
            if (editor && this._selectedConfig && this._selectedConfig.ID === selectedConfigId) {
                const editorValue = editor.getValue();
                if (editorValue && editorValue.trim()) {
                    configData = editorValue;
                }
            }
            
            // Format the JSON nicely for the new config editor
            let formattedConfigData = configData;
            try {
                formattedConfigData = JSON.stringify(JSON.parse(configData), null, 2);
            } catch (e) {
                // Keep original if not valid JSON
                formattedConfigData = configData;
            }
            
            if (viewModel) {
                viewModel.setProperty("/dialogMode", "duplicate");
                viewModel.setProperty("/dialogTitle", "Duplicate Configuration");
                viewModel.setProperty("/newConfig", {
                    name: fullConfig.name + " (Copy)",
                    version: fullConfig.version,
                    description: fullConfig.description || "",
                    configData: formattedConfigData
                });
            }
            
            const dialog = this.byId("createConfigDialog") as Dialog;
            dialog.open();
            
            // Trigger CodeEditor resize after dialog opens with dynamic height calculation
            setTimeout(() => {
                this._setDynamicEditorHeight("newConfigEditor");
                this._setupDialogResizeHandler("newConfigEditor");
            }, 100);
            
        }).catch((error: any) => {
            console.error("Error loading configuration for duplication:", error);
            MessageBox.error("Failed to load configuration data for duplication: " + error.message);
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Delete configuration
     */
    public onDeleteConfiguration(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const selectedConfigIds = viewModel?.getProperty("/selectedConfigIds") || [];
        
        if (selectedConfigIds.length === 0) {
            MessageBox.error("Please select configurations to delete");
            return;
        }

        const confirmText = `Delete ${selectedConfigIds.length} configuration(s)?\n\nThis action cannot be undone.`;
        
        MessageBox.confirm(confirmText, {
            onClose: (action: string) => {
                if (action === MessageBox.Action.OK) {
                    this._deleteConfigurations(selectedConfigIds);
                }
            }
        });
    }

    /**
     * Internal method to delete configurations by IDs
     */
    private _deleteConfigurations(configIds: string[]): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        // Find the contexts for the selected configurations
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items");
        const contexts = binding?.getCurrentContexts();
        
        const targetContexts = [];
        if (contexts) {
            for (const context of contexts) {
                const config = context.getObject();
                if (config?.ID && configIds.includes(config.ID)) {
                    targetContexts.push(context);
                }
            }
        }

        if (targetContexts.length === 0) {
            MessageBox.error("Cannot delete configurations: Contexts not found");
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
            return;
        }

        // Delete all selected configurations
        Promise.all(targetContexts.map(context => context.delete())).then(() => {
            MessageToast.show(`${targetContexts.length} configuration(s) deleted successfully`);
            
            // Clear selection
            table.removeSelections();
            this._selectedConfig = null;
            if (viewModel) {
                viewModel.setProperty("/selectedConfigId", null);
                viewModel.setProperty("/selectedConfigIds", []);
                viewModel.setProperty("/selectedConfigCanActivate", false);
                viewModel.setProperty("/selectedConfigCanDelete", false);
            }
            
            // Clear binding context from detail page
            const detailPage = this.byId("detailDynamicPage");
            if (detailPage) {
                detailPage.setBindingContext(null);
            }
            
            const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
            if (fcl) {
                fcl.setLayout("OneColumn");
            }
            
            // Refresh the list
            this._loadConfigurations();
        }).catch((error: Error) => {
            console.error("Delete error:", error);
            
            // Extract more meaningful error message from OData error structure
            let errorMessage = "Error deleting configurations";
            
            if (error && (error as any).response && (error as any).response.body) {
                const errorBody = (error as any).response.body;
                if (errorBody.error && errorBody.error.message) {
                    errorMessage = errorBody.error.message;
                } else if (errorBody.message) {
                    errorMessage = errorBody.message;
                }
            } else if (error.message) {
                // Check if it's a generic "Forbidden" and provide better context
                if (error.message.toLowerCase().includes('forbidden')) {
                    errorMessage = "Cannot delete the selected configuration(s). Active configurations cannot be deleted - please deactivate them first.";
                } else {
                    errorMessage = error.message;
                }
            }
            
            MessageBox.error(errorMessage);
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Handle JSON editor changes
     */
    public onConfigDataChange(): void {
        // Could add auto-validation or change tracking here
    }

    /**
     * Format date for display
     */
    public formatDate(dateValue: string): string {
        if (!dateValue) return "";
        try {
            const date = new Date(dateValue);
            return date.toLocaleDateString() + " " + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        } catch (e) {
            return dateValue;
        }
    }

    /**
     * Format datetime for display with more detail
     */
    public formatDateTime(dateValue: string): string {
        if (!dateValue) return "";
        try {
            const date = new Date(dateValue);
            return date.toLocaleDateString() + " at " + date.toLocaleTimeString();
        } catch (e) {
            return dateValue;
        }
    }

    /**
     * Defensive boolean formatter - handles any type conversion issues
     */
    public bool(v: any): boolean {
        // Handle various truthy boolean representations
        if (v === true || v === 1 || v === "1" || v === "true" || v === "Yes") {
            return true;
        }
        // Handle various falsy boolean representations  
        if (v === false || v === 0 || v === "0" || v === "false" || v === "No") {
            return false;
        }
        // Default to falsy for unknown values
        return false;
    }

    /**
     * Format active status text
     */
    public activeText(v: any): string {
        return this.bool(v) ? "Active" : "Inactive";
    }

    /**
     * Format active status state
     */
    public activeState(v: any): string {
        return this.bool(v) ? "Success" : "None";
    }

    /**
     * Format active status icon
     */
    public activeIcon(v: any): string {
        return this.bool(v) ? "sap-icon://accept" : "sap-icon://pending";
    }


    /**
     * Open rollback reason dialog
     */
    public onRollbackConfiguration(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            // Clear previous reason
            viewModel.setProperty("/rollbackReason", "");
        }
        
        const dialog = this.byId("rollbackReasonDialog") as Dialog;
        dialog.open();
    }

    /**
     * Cancel rollback
     */
    public onCancelRollback(): void {
        const dialog = this.byId("rollbackReasonDialog") as Dialog;
        dialog.close();
        
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/rollbackReason", "");
        }
    }

    /**
     * Handle rollback reason input change
     */
    public onRollbackReasonChange(event: any): void {
        const value = event.getParameter("value");
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/rollbackReason", value);
        }
    }

    /**
     * Execute rollback configuration
     */
    public onConfirmRollback(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const rollbackReason = viewModel?.getProperty("/rollbackReason")?.trim();
        
        // Validate reason is provided
        if (!rollbackReason) {
            MessageBox.error("Rollback reason is mandatory");
            return;
        }

        // Close dialog immediately since reason is provided
        const dialog = this.byId("rollbackReasonDialog") as Dialog;
        dialog.close();

        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        const oModel = this.getView()?.getModel() as ODataModel;
        const actionBinding = oModel.bindContext("/rollbackConfiguration(...)");
        
        actionBinding.setParameter("reason", rollbackReason);

        actionBinding.execute().then(() => {
            const result = actionBinding.getBoundContext()?.getObject();
            
            if (result?.success) {
                const message = `Rollback successful!\n\nRolled back from: ${result.rolledBackFrom}\nRolled back to: ${result.rolledBackTo}\nReason: ${result.reason}\nRolled back at: ${new Date(result.rolledBackAt).toLocaleString()}`;
                MessageBox.success(message);
            } else {
                MessageBox.error("Rollback failed: " + (result?.error || "Unknown error"));
            }
            
            // Always refresh the table after rollback attempt
            this._refreshTable();
        }).catch((error: Error) => {
            console.error("Rollback error:", error);
            
            // Extract meaningful error message
            let errorMessage = "Error during rollback";
            if (error && (error as any).response && (error as any).response.body) {
                const errorBody = (error as any).response.body;
                if (errorBody.error && errorBody.error.message) {
                    errorMessage = errorBody.error.message;
                } else if (errorBody.message) {
                    errorMessage = errorBody.message;
                }
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            MessageBox.error(errorMessage);
            
            // Refresh table even on error to show current state
            this._refreshTable();
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
                // Clear the rollback reason after operation
                viewModel.setProperty("/rollbackReason", "");
            }
        });
    }

    /**
     * Refresh the configuration table
     */
    private _refreshTable(): void {
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items");
        if (binding) {
            binding.refresh();
        }
    }

    /**
     * Toggle edit mode for the configuration editor
     */
    public onToggleEditMode(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) return;
        
        const currentEditMode = viewModel.getProperty("/isEditMode");
        const newEditMode = !currentEditMode;
        
        console.log(`📝 Toggling edit mode: ${currentEditMode} → ${newEditMode}`);
        
        // Update view model
        viewModel.setProperty("/isEditMode", newEditMode);
        
        // Update editor editable state
        const editor = this._getActiveEditor();
        if (editor) {
            editor.setEditable(newEditMode);
            console.log(`📝 Editor editable state set to: ${newEditMode}`);
        }
        
        if (newEditMode) {
            // Entering edit mode: store original value for potential cancel
            if (editor) {
                this._originalEditorValue = editor.getValue();
                this._isEditorDirty = false;
                this._updateDirtyStateUI();
                console.log("📝 Entering edit mode - stored original value for cancel");
            }
        } else {
            // Exiting edit mode (Cancel): revert to original content
            if (editor && this._originalEditorValue !== undefined) {
                editor.setValue(this._originalEditorValue);
                this._isEditorDirty = false;
                this._updateDirtyStateUI();
                console.log("📝 Cancelled edit mode - reverted to original content");
            }
        }
    }

    /**
     * Set dynamic height for CodeEditor based on dialog dimensions and structure
     */
    private _setDynamicEditorHeight(editorId: string): void {
        const editor = this.byId(editorId) as CodeEditor;
        if (!editor) {
            console.warn(`CodeEditor ${editorId} not found for dynamic height setting`);
            return;
        }

        // Wait for editor to be rendered, then calculate optimal height
        setTimeout(() => {
            const editorDom = editor.getDomRef();
            if (!editorDom) {
                console.warn("CodeEditor DOM not ready, falling back to fixed height");
                this._setFixedEditorHeight(editor, 400);
                return;
            }

            // Find dialog body and panel to calculate available space
            const dialogBody = document.querySelector('.dialogBody') as HTMLElement;
            const rightPanel = editorDom.closest('.fullHeightPanel') as HTMLElement;
            
            if (!dialogBody || !rightPanel) {
                console.warn("Dialog structure not found, falling back to fixed height");
                this._setFixedEditorHeight(editor, 400);
                return;
            }

            // Calculate available height based on dialog structure
            const dialogBodyHeight = dialogBody.getBoundingClientRect().height;
            const panelHeaderHeight = 44; // Approximate panel header height
            const panelPadding = 24; // 12px top + 12px bottom padding
            const buffer = 20; // Safety buffer
            
            // Calculate optimal height: dialog body height minus panel overhead
            const optimalHeight = Math.max(dialogBodyHeight - panelHeaderHeight - panelPadding - buffer, 200);
            
            console.log(`Calculated optimal height for ${editorId}:`, {
                dialogBodyHeight,
                panelHeaderHeight,
                panelPadding,
                buffer,
                optimalHeight
            });

            // Apply the calculated height
            this._setFixedEditorHeight(editor, optimalHeight);
        }, 150); // Delay to ensure DOM is fully rendered
    }

    /**
     * Set fixed height on CodeEditor and its ACE editor
     */
    private _setFixedEditorHeight(editor: CodeEditor, height: number): void {
        const heightPx = height + "px";
        
        // Set height on the UI5 CodeEditor
        editor.setHeight(heightPx);
        
        // Also set height on the DOM element directly
        const editorDom = editor.getDomRef();
        if (editorDom) {
            editorDom.style.height = heightPx;
            editorDom.style.minHeight = heightPx;
            
            // Set height on ACE editor inside
            const aceEditor = editorDom.querySelector('.ace_editor') as HTMLElement;
            if (aceEditor) {
                aceEditor.style.height = heightPx;
                aceEditor.style.minHeight = heightPx;
            }
        }

        // Trigger ACE editor resize if available
        setTimeout(() => {
            (editor as any).getAggregation?.("_editor")?.resize?.();
        }, 50);

        console.log(`✅ CodeEditor height set to ${heightPx} dynamically`);
    }

    /**
     * Setup resize observer for dialog to recalculate editor height on resize
     */
    private _setupDialogResizeHandler(editorId: string): void {
        const dialog = this.byId("createConfigDialog") as Dialog;
        if (!dialog) {
            console.warn("Dialog not found for resize handler setup");
            return;
        }

        // Clean up any existing resize observer
        this._cleanupDialogResizeHandler();

        // Wait for dialog to be fully rendered
        setTimeout(() => {
            const dialogDom = dialog.getDomRef();
            if (!dialogDom) {
                console.warn("Dialog DOM not available for resize handler");
                return;
            }

            // Create ResizeObserver to watch dialog size changes
            this._dialogResizeObserver = new ResizeObserver((entries) => {
                // Throttle resize events to avoid excessive recalculations
                if (this._resizeThrottleTimeout) {
                    clearTimeout(this._resizeThrottleTimeout);
                }

                this._resizeThrottleTimeout = setTimeout(() => {
                    console.log("Dialog resized, recalculating editor height...");
                    this._setDynamicEditorHeight(editorId);
                }, 250); // 250ms throttle
            });

            // Observe the dialog element for size changes
            this._dialogResizeObserver.observe(dialogDom);
            console.log("✅ Dialog resize handler setup complete");
        }, 200);
    }

    /**
     * Clean up dialog resize handler
     */
    private _cleanupDialogResizeHandler(): void {
        if (this._dialogResizeObserver) {
            this._dialogResizeObserver.disconnect();
            this._dialogResizeObserver = null;
            console.log("🧹 Dialog resize observer cleaned up");
        }

        if (this._resizeThrottleTimeout) {
            clearTimeout(this._resizeThrottleTimeout);
            this._resizeThrottleTimeout = null;
        }
    }

    /**
     * Format the configuration title for display
     */
    public formatConfigTitle(name: string, version: string): string {
        if (!name || !version) {
            return "Configuration Details";
        }
        return `${name} (${version})`;
    }
}
