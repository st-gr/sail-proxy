sap.ui.define(["sap/m/MessageToast", "sap/m/MessageBox", "sap/m/TableSelectDialog", "sap/m/ColumnListItem", "sap/m/Column", "sap/m/Label", "sap/m/Text", "sap/ui/model/Filter", "sap/ui/model/FilterOperator"], function (MessageToast, MessageBox, TableSelectDialog, ColumnListItem, Column, Label, Text, Filter, FilterOperator) {
	"use strict";

	// Assigning a user or an API key to a tool policy is neither a create nor a delete on the table
	// that shows it: the row is an existing user or key, and the four bound actions on ToolPolicies
	// are the only write path. Fiori Elements has no annotation that puts a PARENT-bound action into
	// a CHILD table's toolbar, so the two buttons per table are custom actions declared in
	// manifest.json. A manifest action's handler is called with the page's binding context and the
	// rows selected in that table (the shape security-notifications-app's BulkActions.ts relies on).
	//
	// "Assign" opens a searchable list of the candidates instead of Fiori Elements'
	// action-parameter dialog, which asked for an email address or a key UUID as free text.
	// "Unassign" needs no dialog at all: it acts on the rows selected in the table.

	function actionName(name) {
		return "AdminService." + name;
	}

	/** Invokes a bound action on the policy the object page shows, once per parameter value. */
	function invoke(policyContext, name, parameterName, values) {
		var model = policyContext.getModel();
		return values.reduce(function (chain, value) {
			return chain.then(function () {
				var operation = model.bindContext(actionName(name) + "(...)", policyContext);
				operation.setParameter(parameterName, value);
				return operation.execute();
			});
		}, Promise.resolve());
	}

	/** Refreshes the object page so both assignment tables and the counter show the new state. */
	function refresh(policyContext) {
		try {
			policyContext.refresh();
		} catch (error) {
			policyContext.getModel().refresh();
		}
	}

	function report(policyContext, message) {
		refresh(policyContext);
		MessageToast.show(message);
	}

	function fail(error) {
		var message = (error && error.message) || String(error);
		MessageBox.error(message);
	}

	/**
	 * A multi-select TableSelectDialog over an entity set: `columns` are {label, path} pairs (the
	 * first is the row's title), `key` is the property the action takes, and `searchProperties` are
	 * the properties the search field matches, joined with OR and filtered on the SERVER - so a
	 * tenant with hundreds of keys pages through them instead of loading them all.
	 *
	 * Several rows can be picked at once; `onPicked` is called with every chosen key.
	 */
	function pick(policyContext, settings) {
		// Neither TableSelectDialog nor SelectDialog has a public close(): both close themselves and
		// fire "confirm" from inside that close sequence, AFTER "afterClose". Destroying the dialog in
		// afterClose therefore tears it down before confirm can read the chosen rows, so the teardown
		// is deferred to the next tick and confirm is the only place that reads them.
		var destroyLater = function (dialog) {
			setTimeout(function () { dialog.destroy(); }, 0);
		};
		var searchFilter = function (value) {
			if (!value) return [];
			var parts = settings.searchProperties.map(function (path) {
				return new Filter(path, FilterOperator.Contains, value);
			});
			return [parts.length === 1 ? parts[0] : new Filter({ filters: parts, and: false })];
		};
		var dialog = new TableSelectDialog({
			title: settings.title,
			noDataText: settings.noDataText,
			// The default label is "Select", which says nothing about what happens next.
			confirmButtonText: "Assign",
			multiSelect: true,
			growing: true,
			growingThreshold: 50,
			search: function (event) {
				event.getSource().getBinding("items").filter(searchFilter(event.getParameter("value")));
			},
			confirm: function (event) {
				var contexts = event.getParameter("selectedContexts")
					|| (event.getParameter("selectedItems") || []).map(function (item) { return item.getBindingContext(); });
				var values = (contexts || []).map(function (context) { return context.getProperty(settings.key); })
					.filter(function (value) { return value !== undefined && value !== null; });
				destroyLater(dialog);
				if (values.length > 0) settings.onPicked(values);
			},
			cancel: function () {
				destroyLater(dialog);
			}
		});
		settings.columns.forEach(function (column) {
			dialog.addColumn(new Column({ header: new Label({ text: column.label }) }));
		});
		dialog.setModel(policyContext.getModel());
		dialog.bindAggregation("items", {
			path: settings.path,
			sorter: settings.sorter,
			template: new ColumnListItem({
				cells: settings.columns.map(function (column) {
					return new Text({ text: "{" + column.path + "}", wrapping: false });
				})
			})
		});
		dialog.open();
	}

	/** "3 API keys assigned" / "1 API key assigned". */
	function assigned(count, singular, plural) {
		return count + " " + (count === 1 ? singular : plural) + " assigned";
	}

	return {
		/** "Assign User" on the Assigned Users table: pick users, then assignUser(email) per user. */
		onAssignUser: function (policyContext) {
			pick(policyContext, {
				title: "Assign Users",
				noDataText: "No users found",
				path: "/Users",
				key: "email",
				searchProperties: ["email", "displayName"],
				columns: [
					{ label: "Email", path: "email" },
					{ label: "Name", path: "displayName" },
					{ label: "Status", path: "status" },
					{ label: "Current Policy", path: "toolPolicy/name" }
				],
				onPicked: function (emails) {
					invoke(policyContext, "assignUser", "email", emails)
						.then(function () { report(policyContext, assigned(emails.length, "user", "users")); })
						.catch(fail);
				}
			});
		},

		/** "Unassign" on the Assigned Users table: acts on the selected rows, no dialog. */
		onUnassignUsers: function (policyContext, selected) {
			var emails = (selected || []).map(function (context) { return context.getProperty("email"); });
			if (emails.length === 0) {
				MessageToast.show("Select the users to unassign");
				return;
			}
			invoke(policyContext, "unassignUser", "email", emails)
				.then(function () { report(policyContext, emails.length + " user(s) unassigned"); })
				.catch(fail);
		},

		/** "Assign API Key" on the Assigned API Keys table: pick keys, then assignApiKey(keyId) per key. */
		onAssignApiKey: function (policyContext) {
			pick(policyContext, {
				title: "Assign API Keys",
				noDataText: "No API keys found",
				path: "/ApiKeys",
				key: "ID",
				searchProperties: ["name", "email"],
				columns: [
					{ label: "Key", path: "name" },
					{ label: "Owner", path: "email" },
					{ label: "Current Policy", path: "toolPolicy/name" }
				],
				onPicked: function (keyIds) {
					invoke(policyContext, "assignApiKey", "keyId", keyIds)
						.then(function () { report(policyContext, assigned(keyIds.length, "API key", "API keys")); })
						.catch(fail);
				}
			});
		},

		/** "Unassign" on the Assigned API Keys table: acts on the selected rows, no dialog. */
		onUnassignApiKeys: function (policyContext, selected) {
			var ids = (selected || []).map(function (context) { return context.getProperty("ID"); });
			if (ids.length === 0) {
				MessageToast.show("Select the API keys to unassign");
				return;
			}
			invoke(policyContext, "unassignApiKey", "keyId", ids)
				.then(function () { report(policyContext, ids.length + " API key(s) unassigned"); })
				.catch(fail);
		}
	};
});
