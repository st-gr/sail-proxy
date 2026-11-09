sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press",
	"sap/ui/test/actions/EnterText"
], function (Opa5, Press, EnterText) {
	"use strict";

	var sList = "Jobs";          // admin.grounding.view.Jobs
	var sDetail = "JobDetail";   // admin.grounding.view.JobDetail
	var sStore = "StoreDetail";  // admin.grounding.view.StoreDetail

	Opa5.createPageObjects({
		onTheJobs: {
			actions: {
				iUploadAndAttachTogether: function (aFiles) {
					// Like onTheStores.iUploadAndAttach, with several files: the page makes them one batch.
					return this.waitFor({
						viewName: sStore,
						id: "storeDetailPage",
						success: function (oPage) {
							var FrameFile = Opa5.getWindow().File;
							var oController = oPage.getParent().getController();
							oController.uploadAndAttach(aFiles.map(function (oFile) {
								return new FrameFile([oFile.content], oFile.name, { type: "text/plain" });
							}));
						}
					});
				},
				iPressViewJob: function () {
					return this.waitFor({ id: "viewJobLink", viewName: sStore, actions: new Press() });
				},
				iGoBackToTheJobs: function () {
					return this.waitFor({
						id: "jobDetailPage",
						viewName: sDetail,
						success: function (oPage) { oPage.fireNavButtonPress(); }
					});
				},
				iOpenTheTestRetrievalTab: function () {
					return this.waitFor({
						id: "storeTabs",
						viewName: sStore,
						success: function (oTabBar) { oTabBar.setSelectedKey("test"); }
					});
				},
				iSearchFor: function (sQuery) {
					return this.waitFor({
						id: "searchQueryInput",
						viewName: sStore,
						actions: new EnterText({ text: sQuery }),
						success: function () {
							this.waitFor({ id: "searchButton", viewName: sStore, actions: new Press() });
						}
					});
				}
			},
			assertions: {
				iSeeTheJobStarted: function () {
					return this.waitFor({
						id: "jobStartedStrip",
						viewName: sStore,
						timeout: 60,
						check: function (oStrip) { return oStrip.getText().indexOf("Job started") === 0; },
						success: function (oStrip) { Opa5.assert.ok(true, "The store page says: " + oStrip.getText()); },
						errorMessage: "The store page did not report a started job"
					});
				},
				iSeeTheJobWithState: function (sStateText, sProgress) {
					// Ingestion is a real embedding call; the job page refreshes itself while the job is active.
					return this.waitFor({
						id: "jobDetailPage",
						viewName: sDetail,
						timeout: 120,
						check: function (oPage) {
							var oView = oPage.getParent();
							return oView.byId("jobState").getText() === sStateText && oView.byId("jobProgress").getText() === sProgress;
						},
						success: function () { Opa5.assert.ok(true, "The job is " + sStateText + " with " + sProgress + " files"); },
						errorMessage: "The job did not reach " + sStateText + " with " + sProgress + " files"
					});
				},
				iSeeAJobOfTheStoreWithState: function (sStoreName, sStateText) {
					return this.waitFor({
						id: "jobsTable",
						viewName: sList,
						check: function (oTable) {
							// cells: kind, store, state, progress, …
							return oTable.getItems().some(function (oItem) {
								var aCells = oItem.getCells();
								return aCells[1].getText() === sStoreName && aCells[2].getText() === sStateText;
							});
						},
						success: function () { Opa5.assert.ok(true, "The Jobs screen lists a " + sStateText + " job of " + sStoreName); },
						errorMessage: "The Jobs screen lists no " + sStateText + " job of " + sStoreName
					});
				},
				iSeeTheFirstResultFrom: function (sFileName) {
					return this.waitFor({
						id: "searchResultsTable",
						viewName: sStore,
						timeout: 60,
						check: function (oTable) {
							var aItems = oTable.getItems();
							return !oTable.getBusy() && aItems.length > 0 && aItems[0].getCells()[1].getText() === sFileName;
						},
						success: function () { Opa5.assert.ok(true, "The best passage comes from " + sFileName); },
						errorMessage: "The first search result is not from " + sFileName
					});
				}
			}
		}
	});
});
