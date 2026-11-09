import Dialog from "sap/m/Dialog";
import Button from "sap/m/Button";
import Label from "sap/m/Label";
import Select from "sap/m/Select";
import Text from "sap/m/Text";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import ListItem from "sap/ui/core/ListItem";
import SimpleForm from "sap/ui/layout/form/SimpleForm";
import { ButtonType } from "sap/m/library";
import Context from "sap/ui/model/odata/v4/Context";
import ODataContextBinding from "sap/ui/model/odata/v4/ODataContextBinding";
import ResourceBundle from "sap/base/i18n/ResourceBundle";

/** One entry of AdminService.credentialTeamChoices (admin-service.cds). */
type TeamChoice = { teamId: string; name: string; isPrimary: boolean };

/** Which credential this module serves: the bundle, the binding action and its key parameter. */
const BUNDLE = "admin.app.i18n.i18n";
const ACTION = "/setApiKeyTeam(...)";
const ID_PARAMETER = "keyId";

let bundlePromise: Promise<ResourceBundle> | undefined;
function getBundle(): Promise<ResourceBundle> {
    if (!bundlePromise) {
        bundlePromise = ResourceBundle.create({
            bundleName: BUNDLE, async: true,
            supportedLocales: ["", "de", "es", "fr", "it", "nl", "pt"], fallbackLocale: ""
        }) as Promise<ResourceBundle>;
    }
    return bundlePromise;
}

/**
 * Change Team (spec 2026-10-14 §9): binds the credential to one of its owner's teams, or lets it
 * follow the owner's primary team again. The owner's teams come from credentialTeamChoices
 * (owner or admin); the server re-checks membership on save.
 */
export default {
    isVisible: function (oBindingContext: Context): boolean {
        return !!oBindingContext && oBindingContext.getProperty("IsActiveEntity") === true;
    },

    onChangeTeam: async function (oBindingContext: Context): Promise<void> {
        let bundle: ResourceBundle;
        try { bundle = await getBundle(); } catch (error) { MessageBox.error(String(error)); return; }
        const text = (key: string) => bundle.getText(key) as string;
        const model = oBindingContext.getModel();
        let teams: TeamChoice[] = [];
        let current = "";
        let id = "";
        try {
            const [owner, teamId, credentialId] = await oBindingContext.requestProperty(["email", "team_ID", "ID"]) as [string, string | null, string];
            current = teamId ?? "";
            id = credentialId;
            // A credential without an owner has no teams to choose from (the server requires an email).
            if (owner) {
                const choices = model.bindContext("/credentialTeamChoices(...)") as ODataContextBinding;
                choices.setParameter("email", owner);
                await choices.execute();
                teams = ((choices.getBoundContext()?.getObject() as { value?: TeamChoice[] } | undefined)?.value) ?? [];
            }
        } catch (error) {
            MessageBox.error((error as Error).message);
            return;
        }
        const select = new Select({ width: "100%", showSecondaryValues: true });
        select.addItem(new ListItem({ key: "", text: text("followPrimaryTeam") }));
        for (const t of teams) select.addItem(new ListItem({ key: t.teamId, text: t.name, additionalText: t.isPrimary ? text("primaryTeam") : "" }));
        select.setSelectedKey(current);
        const dialog: Dialog = new Dialog({
            title: text("changeTeam"),
            contentWidth: "28rem",
            content: [new SimpleForm({ editable: true, layout: "ResponsiveGridLayout", content: [
                new Text({ text: text(teams.length ? "changeTeamHelp" : "changeTeamNoTeams") }),
                new Label({ text: text("team"), labelFor: select }),
                select
            ] })],
            beginButton: new Button({ text: text("save"), type: ButtonType.Emphasized, press: async () => {
                const op = model.bindContext(ACTION) as ODataContextBinding;
                op.setParameter(ID_PARAMETER, id);
                op.setParameter("teamId", select.getSelectedKey() || null);
                try {
                    await op.execute("$auto");
                    await oBindingContext.requestSideEffects([{ $PropertyPath: "team_ID" }, { $PropertyPath: "effectiveTeamName" }, { $PropertyPath: "followsPrimaryTeam" }]);
                    dialog.close();
                    MessageToast.show(text("teamChanged"));
                } catch (error) {
                    MessageBox.error((error as Error).message);
                }
            } }),
            endButton: new Button({ text: text("cancel"), press: () => dialog.close() }),
            afterClose: () => dialog.destroy()
        });
        dialog.setModel(model);
        dialog.open();
    }
};
