/**
 * The Tool Inventory's default period must INCLUDE today.
 *
 * Fiori Elements' "Last 30 Days" (LASTDAYS) range ends yesterday. With that as the default, the
 * page opened on "No data found" in every environment whose only recorded tool use was today's —
 * which is every environment where somebody has just tried the feature. TODAYFROMTO(30, 0) is
 * "30 days before today through today", so the rows a client produced minutes ago are visible.
 */
import fs from 'fs';
import path from 'path';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../webapp/manifest.json'), 'utf8'));
const inventory = manifest['sap.ui5'].routing.targets.ToolInventoryList.options.settings;

describe('tool inventory filter defaults', () => {
  it('defaults the period to a window that ends today', () => {
    const day = inventory.controlConfiguration['@com.sap.vocabularies.UI.v1.SelectionFields'].filterFields.day;
    expect(day.settings.defaultValues).toEqual([{ operator: 'TODAYFROMTO', values: [30, 0] }]);
  });

  it('never uses an operator whose range stops before today', () => {
    const serialised = JSON.stringify(inventory.controlConfiguration);
    for (const operator of ['LASTDAYS', 'LASTWEEK', 'LASTMONTH', 'YESTERDAY']) {
      expect(serialised).not.toContain(`"operator":"${operator}"`);
    }
  });
});
