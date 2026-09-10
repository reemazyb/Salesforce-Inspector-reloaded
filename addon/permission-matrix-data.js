import {sfConn, apiVersion} from "./inspector.js";

export const OLS_KEYS = [
  {key: "read", label: "Read", field: "PermissionsRead"},
  {key: "create", label: "Create", field: "PermissionsCreate"},
  {key: "edit", label: "Edit", field: "PermissionsEdit"},
  {key: "delete", label: "Delete", field: "PermissionsDelete"},
  {key: "viewAll", label: "View All", field: "PermissionsViewAllRecords"},
  {key: "modifyAll", label: "Modify All", field: "PermissionsModifyAllRecords"}
];

const GET = {method: "GET"};
const FIELD_CHUNK = 40;

export function escapeSoql(value) {
  return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function soqlQuote(value) {
  return "'" + escapeSoql(value) + "'";
}

export function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

export async function queryAll(soql) {
  let result = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql), GET);
  const records = result.records ? result.records.slice() : [];
  while (!result.done && result.nextRecordsUrl) {
    result = await sfConn.rest(result.nextRecordsUrl, GET);
    if (result.records) {
      records.push(...result.records);
    }
  }
  return records;
}

function emptyOls() {
  const ols = {};
  for (const item of OLS_KEYS) {
    ols[item.key] = false;
  }
  return ols;
}

function recordToOls(record) {
  const ols = emptyOls();
  if (!record) {
    return ols;
  }
  for (const item of OLS_KEYS) {
    ols[item.key] = !!record[item.field];
  }
  return ols;
}

export function toParent(permissionSet, assignment) {
  const ps = permissionSet || {};
  let kind = "permissionSet";
  let label = ps.Label || ps.Name || ps.Id;
  if (ps.IsOwnedByProfile) {
    kind = "profile";
    label = (ps.Profile && ps.Profile.Name) || label;
  } else if (ps.Type === "Group") {
    kind = "group";
    const group = assignment && assignment.PermissionSetGroup;
    label = (group && (group.MasterLabel || group.DeveloperName)) || label;
  }
  return {
    id: ps.Id,
    name: ps.Name,
    label,
    kind,
    type: ps.Type,
    profileId: ps.ProfileId || null
  };
}

export function sortParents(parents) {
  const rank = {profile: 0, group: 1, permissionSet: 2};
  return parents.slice().sort((a, b) => {
    const rankDiff = (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return String(a.label).localeCompare(String(b.label));
  });
}

export function parentKindLabel(kind) {
  if (kind === "profile") {
    return "Profile";
  }
  if (kind === "group") {
    return "Permission Set Group";
  }
  return "Permission Set";
}

export async function searchUsers(term) {
  const escaped = escapeSoql(term.trim());
  if (!escaped) {
    return [];
  }
  const soql = "SELECT Id, Name, Username, Email, IsActive, Alias, ProfileId, Profile.Name"
    + " FROM User WHERE (Name LIKE '%" + escaped + "%' OR Username LIKE '%" + escaped + "%'"
    + " OR Email LIKE '%" + escaped + "%' OR Alias LIKE '%" + escaped + "%')"
    + " ORDER BY IsActive DESC, Name LIMIT 20";
  return queryAll(soql);
}

export async function getUserById(userId) {
  const records = await queryAll(
    "SELECT Id, Name, Username, Email, IsActive, Alias, ProfileId, Profile.Name FROM User WHERE Id = " + soqlQuote(userId) + " LIMIT 1"
  );
  return records[0] || null;
}

export async function listProfiles() {
  const records = await queryAll(
    "SELECT Id, Name, Label, Type, IsOwnedByProfile, ProfileId, Profile.Name FROM PermissionSet WHERE IsOwnedByProfile = true ORDER BY Profile.Name"
  );
  return sortParents(records.map(record => toParent(record)));
}

export async function searchPermissionSets(term) {
  const escaped = escapeSoql(term.trim());
  if (!escaped) {
    return [];
  }
  const records = await queryAll(
    "SELECT Id, Name, Label, Type, IsOwnedByProfile, ProfileId, Profile.Name FROM PermissionSet"
    + " WHERE IsOwnedByProfile = false AND Type != 'Group' AND (Label LIKE '%" + escaped + "%' OR Name LIKE '%" + escaped + "%')"
    + " ORDER BY Label LIMIT 50"
  );
  return sortParents(records.map(record => toParent(record)));
}

export async function getPermissionSetsByIds(ids) {
  if (!ids.length) {
    return [];
  }
  const groups = await Promise.all(chunk(ids, 100).map(group => queryAll(
    "SELECT Id, Name, Label, Type, IsOwnedByProfile, ProfileId, Profile.Name FROM PermissionSet WHERE Id IN ("
    + group.map(soqlQuote).join(",") + ")"
  )));
  return sortParents(groups.flat().map(record => toParent(record)));
}

export async function getUserAssignments(userId) {
  const idClause = " WHERE AssigneeId = " + soqlQuote(userId);
  const fields = "SELECT PermissionSetId, PermissionSetGroupId, PermissionSet.Id, PermissionSet.Name,"
    + " PermissionSet.Label, PermissionSet.Type, PermissionSet.IsOwnedByProfile, PermissionSet.ProfileId, PermissionSet.Profile.Name";
  let records;
  try {
    records = await queryAll(fields + ", PermissionSetGroup.MasterLabel, PermissionSetGroup.DeveloperName FROM PermissionSetAssignment" + idClause);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (!/INVALID_FIELD|PermissionSetGroup/i.test(msg)) {
      throw err;
    }
    records = await queryAll(fields + " FROM PermissionSetAssignment" + idClause);
  }
  const parents = [];
  const seen = new Set();
  for (const record of records) {
    if (record.PermissionSet && record.PermissionSet.Id && !seen.has(record.PermissionSet.Id)) {
      seen.add(record.PermissionSet.Id);
      parents.push(toParent(record.PermissionSet, record));
    }
  }
  return sortParents(parents);
}

async function queryByParents(selectAndFrom, parentIds, extraWhere) {
  if (!parentIds.length) {
    return [];
  }
  const groups = await Promise.all(chunk(parentIds, 100).map(group => queryAll(
    selectAndFrom + " WHERE ParentId IN (" + group.map(soqlQuote).join(",") + ")" + (extraWhere || "")
  )));
  return groups.flat();
}

export async function getObjectPermissions(parentIds, sobject) {
  const fields = OLS_KEYS.map(item => item.field).join(", ");
  const extra = sobject ? " AND SobjectType = " + soqlQuote(sobject) : "";
  return queryByParents("SELECT ParentId, SobjectType, " + fields + " FROM ObjectPermissions", parentIds, extra);
}

export async function getFieldPermissions(parentIds, sobject) {
  return queryByParents(
    "SELECT ParentId, SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions",
    parentIds,
    " AND SobjectType = " + soqlQuote(sobject)
  );
}

export async function getProfileObjectPermissions(parentId) {
  return getObjectPermissions([parentId]);
}

export async function getObjectPermissionsForSobject(sobject) {
  const fields = OLS_KEYS.map(item => item.field).join(", ");
  return queryAll(
    "SELECT ParentId, SobjectType, " + fields + " FROM ObjectPermissions WHERE SobjectType = " + soqlQuote(sobject)
  );
}

export async function getParentsForSobject(sobject) {
  const rows = await getObjectPermissionsForSobject(sobject);
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.ParentId && !seen.has(row.ParentId)) {
      seen.add(row.ParentId);
      ids.push(row.ParentId);
    }
  }
  const parents = await getPermissionSetsByIds(ids);
  return {parents, objectPerms: rows};
}

export async function describeFields(sobject) {
  const describe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/" + encodeURIComponent(sobject) + "/describe", GET);
  const fields = (describe.fields || []).map(field => ({
    name: field.name,
    label: field.label,
    type: field.type,
    custom: !!field.custom,
    permissionable: !!field.permissionable,
    updateable: !!field.updateable,
    calculated: !!field.calculated
  }));
  fields.sort((a, b) => a.name.localeCompare(b.name));
  return fields;
}

export async function getSystemPermissionFields() {
  const describe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/PermissionSet/describe", GET);
  return (describe.fields || [])
    .filter(field => field.type === "boolean" && field.name.indexOf("Permissions") === 0)
    .map(field => ({
      name: field.name,
      label: field.label || field.name.replace(/^Permissions/, "")
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function getPermissionSetFlags(parentIds, fieldNames) {
  if (!parentIds.length || !fieldNames.length) {
    return [];
  }
  const recordsById = {};
  for (const fieldGroup of chunk(fieldNames, FIELD_CHUNK)) {
    const groups = await Promise.all(chunk(parentIds, 100).map(idGroup => queryAll(
      "SELECT Id, " + fieldGroup.join(", ") + " FROM PermissionSet WHERE Id IN (" + idGroup.map(soqlQuote).join(",") + ")"
    )));
    for (const record of groups.flat()) {
      recordsById[record.Id] = Object.assign(recordsById[record.Id] || {Id: record.Id}, record);
    }
  }
  return Object.keys(recordsById).map(id => recordsById[id]);
}

export async function getCustomPermissionAccess(parentIds) {
  if (!parentIds.length) {
    return {accessRows: [], customPerms: []};
  }
  const accessRows = await queryByParents(
    "SELECT ParentId, SetupEntityId FROM SetupEntityAccess",
    parentIds,
    " AND SetupEntityType = 'CustomPermission'"
  );
  const ids = [];
  const seen = new Set();
  for (const row of accessRows) {
    if (row.SetupEntityId && !seen.has(row.SetupEntityId)) {
      seen.add(row.SetupEntityId);
      ids.push(row.SetupEntityId);
    }
  }
  if (!ids.length) {
    return {accessRows, customPerms: []};
  }
  const groups = await Promise.all(chunk(ids, 100).map(group => queryAll(
    "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix FROM CustomPermission WHERE Id IN (" + group.map(soqlQuote).join(",") + ")"
  )));
  return {accessRows, customPerms: groups.flat()};
}

function fieldApiName(fieldValue, sobject) {
  const prefix = sobject + ".";
  if (fieldValue && fieldValue.startsWith(prefix)) {
    return fieldValue.slice(prefix.length);
  }
  const dot = fieldValue ? fieldValue.lastIndexOf(".") : -1;
  return dot >= 0 ? fieldValue.slice(dot + 1) : fieldValue;
}

function orOls(target, source) {
  for (const item of OLS_KEYS) {
    if (source[item.key]) {
      target[item.key] = true;
    }
  }
}

function objectHasAnyGrant(ols) {
  return OLS_KEYS.some(item => ols[item.key]);
}

export function buildObjectRows({parents, objectPerms, sobjectLabels}) {
  const labels = sobjectLabels || {};
  const bySobject = new Map();

  function ensureRow(sobject) {
    if (bySobject.has(sobject)) {
      return bySobject.get(sobject);
    }
    const sources = {};
    const byParent = {};
    for (const item of OLS_KEYS) {
      sources[item.key] = [];
    }
    for (const parent of parents) {
      byParent[parent.id] = emptyOls();
    }
    const row = {
      sobject,
      label: labels[sobject] || sobject,
      byParent,
      effective: emptyOls(),
      sources
    };
    bySobject.set(sobject, row);
    return row;
  }

  for (const record of objectPerms || []) {
    const row = ensureRow(record.SobjectType);
    row.byParent[record.ParentId] = recordToOls(record);
  }

  for (const row of bySobject.values()) {
    row.effective = emptyOls();
    for (const item of OLS_KEYS) {
      row.sources[item.key] = [];
    }
    for (const parent of parents) {
      const ols = row.byParent[parent.id] || emptyOls();
      orOls(row.effective, ols);
      for (const item of OLS_KEYS) {
        if (ols[item.key]) {
          row.sources[item.key].push(parent.label);
        }
      }
    }
  }

  return Array.from(bySobject.values()).sort((a, b) => a.sobject.localeCompare(b.sobject));
}

export function buildMatrix({fields, parents, objectPerms, fieldPerms, sobject, sobjectLabels}) {
  const objectRows = buildObjectRows({
    parents,
    objectPerms,
    sobjectLabels: sobjectLabels || (sobject ? {[sobject]: sobject} : {})
  });
  const single = objectRows.find(row => row.sobject === sobject) || {
    sobject,
    label: sobject,
    byParent: Object.fromEntries(parents.map(parent => [parent.id, emptyOls()])),
    effective: emptyOls(),
    sources: Object.fromEntries(OLS_KEYS.map(item => [item.key, []]))
  };

  const flsByParent = {};
  for (const parent of parents) {
    flsByParent[parent.id] = {};
  }
  for (const record of fieldPerms || []) {
    const name = fieldApiName(record.Field, sobject);
    if (!flsByParent[record.ParentId]) {
      flsByParent[record.ParentId] = {};
    }
    flsByParent[record.ParentId][name] = {
      read: !!record.PermissionsRead,
      edit: !!record.PermissionsEdit
    };
  }

  const fls = (fields || []).map(field => {
    const byParent = {};
    const readSources = [];
    const editSources = [];
    const alwaysRead = !field.permissionable;
    const alwaysEdit = !field.permissionable && field.updateable && !field.calculated;
    let effectiveRead = alwaysRead;
    let effectiveEdit = alwaysEdit;
    for (const parent of parents) {
      const granted = (flsByParent[parent.id] && flsByParent[parent.id][field.name]) || {read: false, edit: false};
      const read = alwaysRead || granted.read;
      const edit = alwaysEdit || granted.edit;
      byParent[parent.id] = {read, edit, alwaysRead, alwaysEdit};
      if (!alwaysRead && granted.read) {
        readSources.push(parent.label);
        effectiveRead = true;
      }
      if (!alwaysEdit && granted.edit) {
        editSources.push(parent.label);
        effectiveEdit = true;
      }
    }
    if (alwaysRead) {
      readSources.push("Not permissionable");
    }
    if (alwaysEdit) {
      editSources.push("Not permissionable");
    }
    return {
      name: field.name,
      label: field.label,
      type: field.type,
      custom: field.custom,
      permissionable: field.permissionable,
      alwaysRead,
      alwaysEdit,
      byParent,
      effective: {read: effectiveRead, edit: effectiveEdit},
      sources: {read: readSources, edit: editSources}
    };
  });

  return {
    ols: {
      byParent: single.byParent,
      effective: single.effective,
      sources: single.sources
    },
    fls,
    objectRows
  };
}

export function buildUserPerms({parents, fields, records}) {
  const byId = {};
  for (const record of records || []) {
    byId[record.Id] = record;
  }
  return (fields || []).map(field => {
    const sources = [];
    let granted = false;
    for (const parent of parents) {
      const record = byId[parent.id];
      if (record && record[field.name]) {
        granted = true;
        sources.push(parent.label);
      }
    }
    return {key: field.name, label: field.label, granted, sources};
  });
}

export function buildCustomPerms({parents, accessRows, customPerms}) {
  const byId = {};
  for (const perm of customPerms || []) {
    byId[perm.Id] = perm;
  }
  const sourcesByPerm = {};
  for (const row of accessRows || []) {
    if (!sourcesByPerm[row.SetupEntityId]) {
      sourcesByPerm[row.SetupEntityId] = [];
    }
    const parent = parents.find(item => item.id === row.ParentId);
    if (parent) {
      sourcesByPerm[row.SetupEntityId].push(parent.label);
    }
  }
  return Object.keys(sourcesByPerm).map(id => {
    const perm = byId[id];
    const name = perm ? ((perm.NamespacePrefix ? perm.NamespacePrefix + "__" : "") + perm.DeveloperName) : id;
    return {
      key: id,
      name,
      label: perm ? (perm.MasterLabel || perm.DeveloperName) : id,
      granted: true,
      sources: sourcesByPerm[id]
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeSnapshot(snapshot) {
  const objectRows = snapshot.objectRows || [];
  const userPerms = snapshot.userPerms || [];
  const customPerms = snapshot.customPerms || [];
  const viewAllData = userPerms.find(item => item.key === "PermissionsViewAllData");
  const modifyAllData = userPerms.find(item => item.key === "PermissionsModifyAllData");
  return {
    assignmentCount: (snapshot.parents || []).length,
    objectCount: objectRows.filter(row => objectHasAnyGrant(row.effective)).length,
    createCount: objectRows.filter(row => row.effective.create).length,
    userPermCount: userPerms.filter(item => item.granted).length,
    customPermCount: customPerms.length,
    viewAllData: !!(viewAllData && viewAllData.granted),
    modifyAllData: !!(modifyAllData && modifyAllData.granted)
  };
}

function csvCell(value) {
  return "\"" + String(value == null ? "" : value).split("\"").join("\"\"") + "\"";
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

function accessLabel(granted, always) {
  if (always) {
    return "Always";
  }
  return granted ? "true" : "false";
}

export function matrixToCsv({mode, objectName, parents, matrix, objectRows, userPerms, customPerms, profileOlsRows}) {
  const lines = [];
  const parentList = parents || [];
  const olsRows = objectRows && objectRows.length
    ? objectRows
    : (profileOlsRows || []).map(record => ({
      sobject: record.SobjectType,
      label: record.SobjectType,
      byParent: {[parentList[0] && parentList[0].id]: recordToOls(record)},
      effective: recordToOls(record),
      sources: {}
    }));

  if (olsRows.length) {
    lines.push(csvRow(["Object Level Security" + (objectName ? " (" + objectName + ")" : "")]));
    if (mode === "object") {
      lines.push(csvRow(["Parent", "Kind", ...OLS_KEYS.map(item => item.label)]));
      const row = olsRows[0];
      for (const parent of parentList) {
        const ols = (row && row.byParent[parent.id]) || emptyOls();
        lines.push(csvRow([parent.label, parentKindLabel(parent.kind), ...OLS_KEYS.map(item => ols[item.key] ? "true" : "false")]));
      }
    } else {
      lines.push(csvRow(["Object", "Label", ...OLS_KEYS.map(item => item.label), ...OLS_KEYS.map(item => item.label + " Source")]));
      for (const row of olsRows) {
        lines.push(csvRow([
          row.sobject,
          row.label,
          ...OLS_KEYS.map(item => row.effective[item.key] ? "true" : "false"),
          ...OLS_KEYS.map(item => (row.sources[item.key] || []).join("; "))
        ]));
      }
    }
    lines.push("");
  } else if (matrix) {
    lines.push(csvRow(["Object Level Security" + (objectName ? " (" + objectName + ")" : "")]));
    if (mode === "object") {
      lines.push(csvRow(["Parent", "Kind", ...OLS_KEYS.map(item => item.label)]));
      for (const parent of parentList) {
        const ols = matrix.ols.byParent[parent.id] || emptyOls();
        lines.push(csvRow([parent.label, parentKindLabel(parent.kind), ...OLS_KEYS.map(item => ols[item.key] ? "true" : "false")]));
      }
    } else {
      lines.push(csvRow(["Row", ...OLS_KEYS.map(item => item.label), ...OLS_KEYS.map(item => item.label + " Source")]));
      lines.push(csvRow([
        "Effective",
        ...OLS_KEYS.map(item => matrix.ols.effective[item.key] ? "true" : "false"),
        ...OLS_KEYS.map(item => (matrix.ols.sources[item.key] || []).join("; "))
      ]));
      for (const parent of parentList) {
        const ols = matrix.ols.byParent[parent.id] || emptyOls();
        lines.push(csvRow([
          parentKindLabel(parent.kind) + ": " + parent.label,
          ...OLS_KEYS.map(item => ols[item.key] ? "true" : "false"),
          ...OLS_KEYS.map(() => "")
        ]));
      }
    }
    lines.push("");
  }

  if (matrix && matrix.fls) {
    lines.push(csvRow(["Field Level Security" + (objectName ? " (" + objectName + ")" : "")]));
    if (mode === "object") {
      const header = ["Field API Name", "Label", "Type", "Permissionable"];
      for (const parent of parentList) {
        header.push(parent.label + " Read", parent.label + " Edit");
      }
      lines.push(csvRow(header));
      for (const field of matrix.fls) {
        const row = [field.name, field.label, field.type, field.permissionable ? "true" : "false"];
        for (const parent of parentList) {
          const cell = field.byParent[parent.id] || {read: false, edit: false};
          row.push(accessLabel(cell.read, field.alwaysRead), accessLabel(cell.edit, field.alwaysEdit));
        }
        lines.push(csvRow(row));
      }
    } else {
      lines.push(csvRow(["Field API Name", "Label", "Type", "Permissionable", "Effective Read", "Effective Edit", "Read Source", "Edit Source"]));
      for (const field of matrix.fls) {
        lines.push(csvRow([
          field.name,
          field.label,
          field.type,
          field.permissionable ? "true" : "false",
          accessLabel(field.effective.read, field.alwaysRead),
          accessLabel(field.effective.edit, field.alwaysEdit),
          (field.sources.read || []).join("; "),
          (field.sources.edit || []).join("; ")
        ]));
      }
    }
    lines.push("");
  }

  if (userPerms && userPerms.length) {
    lines.push(csvRow(["User Permissions"]));
    lines.push(csvRow(["Permission", "API Name", "Granted", "Source"]));
    for (const perm of userPerms) {
      lines.push(csvRow([perm.label, perm.key, perm.granted ? "true" : "false", (perm.sources || []).join("; ")]));
    }
    lines.push("");
  }

  if (customPerms && customPerms.length) {
    lines.push(csvRow(["Custom Permissions"]));
    lines.push(csvRow(["Label", "API Name", "Source"]));
    for (const perm of customPerms) {
      lines.push(csvRow([perm.label, perm.name, (perm.sources || []).join("; ")]));
    }
  }

  return lines.join("\r\n");
}
