import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from './migrate-page.mjs';

const OLD = `---
title: SAIL-PROXY User Guide - Chapter 9
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-8-admin-cockpit.md) | [Content Table](README.md) | [Next Chapter >>](chapter-10-troubleshooting.md)

## Roles Overview

Intro text (adapted from /services/admin/README.md) with a [link][1].

### Admin

#### Details

Text.

[1]: https://example.com/doc

---

[<< Previous Chapter](chapter-8-admin-cockpit.md) | [Content Table](README.md)
`;

test('strips scaffolding, promotes headings, inlines reference links, adds front matter', () => {
  const out = migrate(OLD, { title: 'Roles', description: 'Admin and user roles.' });
  assert.equal(out, `---
title: Roles
description: Admin and user roles.
---

# Roles Overview

Intro text with a [link](https://example.com/doc).

## Admin

### Details

Text.
`);
});

test('a file without the old header is only given front matter and promoted', () => {
  assert.equal(migrate('## T\n\n### S\n\ntext\n', { title: 'T', description: 'd' }), '---\ntitle: T\ndescription: d\n---\n\n# T\n\n## S\n\ntext\n');
});

test('promote: false keeps the heading levels of a page that already has one H1', () => {
  assert.equal(migrate('# Already\n\n## S\n\ntext\n', { title: 'A', description: 'd', promote: false }), '---\ntitle: A\ndescription: d\n---\n\n# Already\n\n## S\n\ntext\n');
});

test('a rule left under the removed header and nav row is stripped too', () => {
  const input = '# SAIL-PROXY User Guide\n*Tagline*\n**Author:** *someone*\n\n[<< Previous Chapter](a.md) | [Content Table](README.md) | [Next Chapter >>](b.md)\n\n---\n\n## T\n\ntext\n';
  assert.equal(migrate(input, { title: 'T', description: 'd' }), '---\ntitle: T\ndescription: d\n---\n\n# T\n\ntext\n');
});

test('a title or description containing ":" or "#" is written as a quoted YAML string', () => {
  assert.equal(
    migrate('# A\n', { title: 'Guide #1', description: 'Start here: the basics.', promote: false }),
    '---\ntitle: "Guide #1"\ndescription: "Start here: the basics."\n---\n\n# A\n'
  );
});
