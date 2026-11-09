/**
 * Teams Part B (spec §9): the Teams nav entry shows for platform administrators and team admins, in
 * the side navigation and its popover copy. Users & Quotas stays administrators-only.
 */
import fs from 'fs';
import path from 'path';

const files = ['../webapp/view/App.view.xml', '../webapp/fragments/SideNavPopover.fragment.xml'];
const visibleOf = (xml: string, key: string) => xml.match(new RegExp(`<tnt:NavigationListItem key="${key}"[^\n]*?visible="([^"]*)"`))?.[1];

describe.each(files)('%s', (file) => {
  const xml = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
  it('binds Teams to isAdmin or isTeamAdmin, and Users & Quotas to isAdmin only', () => {
    expect(visibleOf(xml, 'teams')).toBe('{= ${appView>/isAdmin} || ${appView>/isTeamAdmin} }');
    expect(visibleOf(xml, 'users')).toBe('{appView>/isAdmin}');
  });
  it('binds Connections to isAdmin only', () => {
    expect(visibleOf(xml, 'connections')).toBe('{appView>/isAdmin}');
  });
  it('binds Plugins to isAdmin only, so an admin sees the entry and a user does not', () => {
    expect(visibleOf(xml, 'plugins')).toBe('{appView>/isAdmin}');
  });
});
