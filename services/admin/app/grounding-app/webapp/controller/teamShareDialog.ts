import Dialog from "sap/m/Dialog";
import Button from "sap/m/Button";
import Label from "sap/m/Label";
import Select from "sap/m/Select";
import Text from "sap/m/Text";
import Item from "sap/ui/core/Item";
import VBox from "sap/m/VBox";
import View from "sap/ui/core/mvc/View";
import { ButtonType } from "sap/m/library";
import type { TeamOption } from "../model/teams";

/** Share with Team: pick one of the teams the user may share with; resolves the team id, or null on cancel. */
export async function openTeamShareDialog(view: View, choices: TeamOption[], text: (key: string, args?: unknown[]) => Promise<string>): Promise<string | null> {
  const [title, hint, label, ok, cancel, none] = await Promise.all(["shareWithTeam", "shareWithTeamHint", "chooseTeam", "shareConfirm", "cancel", "noTeamToShare"].map((k) => text(k)));
  return new Promise((resolve) => {
    let picked: string | null = null;
    const select = new Select({ width: "100%", items: choices.map((c) => new Item({ key: c.id, text: c.name })) });
    const dialog = new Dialog({
      title, contentWidth: "26rem",
      content: [new VBox({ items: [new Text({ text: choices.length ? hint : none }), new Label({ text: label, labelFor: select }), select] }).addStyleClass("sapUiSmallMargin")],
      beginButton: new Button({ text: ok, type: ButtonType.Emphasized, enabled: choices.length > 0, press: () => { picked = select.getSelectedKey() || null; dialog.close(); } }),
      endButton: new Button({ text: cancel, press: () => dialog.close() }),
      afterClose: () => { dialog.destroy(); resolve(picked); }
    });
    view.addDependent(dialog);
    dialog.open();
  });
}
