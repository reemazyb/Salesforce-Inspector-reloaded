# Permission Matrix (issue #1325)

Temporary design notes for maintainer review. After approval, move this content to `docs/permission-matrix.md` and add a `CHANGES.md` entry. Do not open a PR until @tprouvot agrees on issue [#1325](https://github.com/tprouvot/Salesforce-Inspector-reloaded/issues/1325).

## Problem

Setup still requires several screens to answer:

- What can this user do on this object?
- Which profiles or permission sets grant OLS or FLS on this object?
- What does this profile grant?

Inspector already speeds up data and metadata work. This tool adds a read-only permission summary with filter and CSV export. It does not replace native Setup editors.

## Modes

| Mode | Input | Output |
|------|--------|--------|
| User | User + object | Effective OLS (CRUD, View All, Modify All) from Profile + Permission Sets + Permission Set Groups. FLS Read/Edit with source labels. |
| Object | Object + one or more Profile / Permission Set / Group | OLS row per parent. FLS matrix with Read/Edit columns per parent. A link switches to User mode for "effective for user X". |
| Profile | Profile, optional object | OLS table for all objects (filterable). FLS for the selected object. |

v1 is read-only. There is no FLS/OLS write, muting editor, custom permission UI, or bulk assign.

## Related issues (not duplicates)

- [#688](https://github.com/tprouvot/Salesforce-Inspector-reloaded/issues/688) Copy/Paste FLS/OLS — editing; this tool cites it and does not reimplement it.
- [#860](https://github.com/tprouvot/Salesforce-Inspector-reloaded/issues/860) Field Creator FLS groups — write path when creating fields.
- [#1176](https://github.com/tprouvot/Salesforce-Inspector-reloaded/issues/1176) FLS visibility on Show All Data — describe vs EntityParticle for the *running* user, not a profile matrix.

## Data model

Salesforce stores Profile, Permission Set, and Permission Set Group object/field access on `PermissionSet` rows:

- Profile → `PermissionSet` with `IsOwnedByProfile = true` and `Profile.Name`.
- Permission Set Group → `PermissionSet` with `Type = 'Group'`. Assignments use the aggregate permission set, which already applies muting.

`PermissionSetAssignment.AssigneeId` returns the user's profile permission set plus assigned permission sets and groups.

Missing `ObjectPermissions` or `FieldPermissions` rows mean no access. Effective access in User mode is OR across parents. Each granted cell keeps the parent labels that contribute.

Non-permissionable describe fields (Id, audit fields, and similar) render as **Always**, not as a blank FLS deny.

## Queries (GET only)

All calls use `sfConn.rest` with the default GET method:

- User search: `User` by Name, Username, Email, Alias (`LIMIT 20`).
- Assignments: `PermissionSetAssignment` for the selected user (optional `PermissionSetGroup` fields, with fallback).
- Profiles: `PermissionSet WHERE IsOwnedByProfile = true`.
- Permission sets: search `Label`/`Name` where `IsOwnedByProfile = false` (avoids loading thousands of rows).
- OLS: `ObjectPermissions` by `ParentId` and `SobjectType`.
- FLS: `FieldPermissions` by `ParentId` and `SobjectType`.
- Fields: `GET /sobjects/{object}/describe`.
- Profile OLS table: `ObjectPermissions WHERE ParentId = :profilePermissionSetId`.

Queries page through `nextRecordsUrl`. Parent Id lists are chunked at 100 for `IN` clauses.

## File layout

| File | Role |
|------|------|
| [addon/permission-matrix.html](addon/permission-matrix.html) | Tool page shell (same pattern as REST Explorer). |
| [addon/permission-matrix.js](addon/permission-matrix.js) | `Model` + React `App`, SLDS layout, URL state. |
| [addon/permission-matrix-data.js](addon/permission-matrix-data.js) | SOQL helpers, merge (`buildMatrix`), CSV (`matrixToCsv`). |
| [addon/permission-matrix.css](addon/permission-matrix.css) | Sticky table header/first column and cell colors. |

Entry points:

- Popup **Data & Metadata** button after Dependencies Explorer (`ref: permissionMatrixBtn`). No single-letter shortcut in v1.
- Chrome command `permission-matrix` (background.js already opens `{command}.html?host=`).
- `web_accessible_resources` in Chrome and Firefox manifests.

URL params: `host`, `mode`, `userId`, `objectType`, `profileId`, `parentIds`.

Reuse: `PageHeader`, `UserInfoModel`, `createSpinForMethod`, `getSobjectsList`, `downloadCsvFile`, `copyToClipboard`, `sfConn.getSession` / `sfConn.rest`.

## Read-only guarantee

The data layer only issues GET query and describe requests. It does not POST, PATCH, or DELETE `FieldPermissions`, `ObjectPermissions`, or assignments. Field Creator remains the write path for new-field FLS.

## Limitations

- `describe` returns fields the **current** Inspector user can see. Fields hidden from that user by FLS do not appear (see #1176).
- Permission Set Groups show as the aggregate permission set. v1 does not list member sets or muting rows.
- Some setup objects do not use standard OLS/FLS rows; a missing row still displays as no access.
- Baseline-column diff highlight from the issue is out of scope for v1.

## Open questions for @tprouvot

1. Keep the name **Permission Matrix**, or prefer Permission Summary / Permission Explorer?
2. Is the popup placement (Data & Metadata, after Dependencies Explorer) correct?
3. Which single-letter popup shortcut, if any? `p` is Options, `m` is Event Monitor, `r` is Org tab.
4. Should v1 stay behind this separate page only, or also get an Options hide-button checkbox?

## After approval

- Add a `CHANGES.md` bullet and `docs/permission-matrix.md` (move this file).
- Add Playwright coverage if that is the expected pattern for new tool pages.
- Open a PR from `feature/permission-matrix` against `releaseCandidate`.
