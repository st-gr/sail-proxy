sap.ui.define(["sap/m/MessageToast", "sap/m/MessageBox", "sap/m/TableSelectDialog", "sap/m/ColumnListItem", "sap/m/Column", "sap/m/Label", "sap/m/Text", "sap/ui/model/json/JSONModel", "sap/ui/model/Filter", "sap/ui/model/FilterOperator", "sap/base/i18n/ResourceBundle"],
function (MessageToast, MessageBox, TableSelectDialog, ColumnListItem, Column, Label, Text, JSONModel, Filter, FilterOperator, ResourceBundle) {
	"use strict";

	var bundlePromise;
	function getBundle() {
		if (!bundlePromise) {
			bundlePromise = ResourceBundle.create({ bundleName: "admin.teams.i18n.i18n", async: true, supportedLocales: ["", "de", "es", "fr", "it", "nl", "pt"], fallbackLocale: "" });
		}
		return bundlePromise;
	}

	// Membership is neither a create nor a delete on the Members table: the four bound actions on
	// Teams are the only write path (same reasoning as tool-policies-app's AssignmentActions). The
	// candidates come from teamMemberCandidates(): a team admin may not read /Users, so the dialog
	// is fed from a JSON model rather than a list binding.
	// Members are not part of what Save writes: in edit mode the page's context is the draft, so the
	// actions go to the saved team (IsActiveEntity=true) and act at once. The server rebuilds the
	// draft's copy of the members, which the side-effect request below reads back into the table.
	function invoke(teamContext, name, params) {
		var model = teamContext.getModel();
		var path = "/Teams(ID=" + teamContext.getProperty("ID") + ",IsActiveEntity=true)/AdminService." + name + "(...)";
		return params.reduce(function (chain, p) {
			return chain.then(function () {
				var op = model.bindContext(path);
				Object.keys(p).forEach(function (k) { op.setParameter(k, p[k]); });
				return op.execute();
			});
		}, Promise.resolve());
	}
	function refresh(teamContext) {
		return Promise.resolve()
			.then(function () { return teamContext.requestSideEffects([{ $NavigationPropertyPath: "members" }, { $PropertyPath: "memberCount" }]); })
			.catch(function () { try { teamContext.refresh(); } catch (e) { teamContext.getModel().refresh(); } });
	}
	function fail(error) { MessageBox.error((error && error.message) || String(error)); }
	function emailsOf(selected) { return (selected || []).map(function (c) { return c.getProperty("email"); }); }

	function pickCandidates(teamContext, bundle, onPicked) {
		var teamId = teamContext.getProperty("ID");
		fetch("/odata/v4/admin/teamMemberCandidates(teamId=" + encodeURIComponent(teamId) + ")", { headers: { Accept: "application/json" }, credentials: "include" })
			.then(function (r) { if (!r.ok) { throw new Error("teamMemberCandidates " + r.status); } return r.json(); })
			.then(function (body) {
				var rows = body.value || [];
				var destroyLater = function (d) { setTimeout(function () { d.destroy(); }, 0); };
				var dialog = new TableSelectDialog({
					title: bundle.getText("addMembersTitle"), noDataText: bundle.getText("noCandidatesFound"), confirmButtonText: bundle.getText("assignButton"),
					multiSelect: true, growing: true, growingThreshold: 50,
					search: function (e) {
						var v = e.getParameter("value");
						e.getSource().getBinding("items").filter(v ? [new Filter({ filters: [new Filter("email", FilterOperator.Contains, v), new Filter("displayName", FilterOperator.Contains, v)], and: false })] : []);
					},
					confirm: function (e) {
						var contexts = e.getParameter("selectedContexts") || [];
						var emails = contexts.map(function (c) { return c.getProperty("email"); }).filter(Boolean);
						destroyLater(dialog);
						if (emails.length > 0) { onPicked(emails); }
					},
					cancel: function () { destroyLater(dialog); }
				});
				[bundle.getText("columnEmail"), bundle.getText("columnName"), bundle.getText("columnStatus")].forEach(function (label) { dialog.addColumn(new Column({ header: new Label({ text: label }) })); });
				dialog.setModel(new JSONModel(rows));
				dialog.bindAggregation("items", { path: "/", template: new ColumnListItem({ cells: [new Text({ text: { path: "email" } }), new Text({ text: { path: "displayName" } }), new Text({ text: { path: "status" } })] }) });
				dialog.open();
			}).catch(fail);
	}

	// Not a method of the returned object: Fiori Elements calls manifest press handlers without the module as `this`.
	function setRole(teamContext, selected, role) {
		var emails = emailsOf(selected);
		getBundle().then(function (bundle) {
			if (emails.length === 0) { MessageToast.show(bundle.getText("selectMembers")); return; }
			invoke(teamContext, "setMemberRole", emails.map(function (email) { return { email: email, role: role }; }))
				.then(function () { refresh(teamContext); MessageToast.show(bundle.getText("roleChanged", [emails.length])); }).catch(fail);
		});
	}

	return {
		onAddMember: function (teamContext) {
			getBundle().then(function (bundle) {
				pickCandidates(teamContext, bundle, function (emails) {
					invoke(teamContext, "addMember", emails.map(function (email) { return { email: email, role: "member" }; }))
						.then(function () { refresh(teamContext); MessageToast.show(bundle.getText(emails.length === 1 ? "memberAddedOne" : "memberAddedOther", [emails.length])); })
						.catch(fail);
				});
			});
		},
		onRemoveMembers: function (teamContext, selected) {
			var emails = emailsOf(selected);
			getBundle().then(function (bundle) {
				if (emails.length === 0) { MessageToast.show(bundle.getText("selectMembers")); return; }
				invoke(teamContext, "removeMember", emails.map(function (email) { return { email: email }; }))
					.then(function () { refresh(teamContext); MessageToast.show(bundle.getText("membersRemoved", [emails.length])); }).catch(fail);
			});
		},
		onMakeAdmin: function (teamContext, selected) { setRole(teamContext, selected, "admin"); },
		onMakeMember: function (teamContext, selected) { setRole(teamContext, selected, "member"); },
		onSetPrimary: function (teamContext, selected) {
			var emails = emailsOf(selected);
			getBundle().then(function (bundle) {
				if (emails.length !== 1) { MessageToast.show(bundle.getText("selectOneMember")); return; }
				invoke(teamContext, "setPrimary", [{ email: emails[0] }])
					.then(function () { refresh(teamContext); MessageToast.show(bundle.getText("primarySet", [teamContext.getProperty("name"), emails[0]])); }).catch(fail);
			});
		}
	};
});
