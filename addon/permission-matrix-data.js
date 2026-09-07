import {sfConn, apiVersion} from "./inspector.js";

export const OLS_KEYS = [
  {key: "read", label: "Read", field: "PermissionsRead"},
  {key: "create", label: "Create", field: "PermissionsCreate"},
  {key: "edit", label: "Edit", field: "PermissionsEdit"},
  {key: "delete", label: "Delete", field: "PermissionsDelete"},
  {key: "viewAll", label: "View All", field: "PermissionsViewAllRecords"},
  {key: "modifyAll", label: "Modify All", field: "PermissionsModifyAllRecords"}
];

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
  let result = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
  const records = result.records ? result.records.slice() : [];
  while (!result.done && result.nextRecordsUrl) {
    result = await sfConn.rest(result.nextRecordsUrl);
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
    + " ORDER BY IsActive DESC, LastLoginDate LIMIT 20";
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
    + " WHERE IsOwnedByProfile = false AND (Label LIKE '%" + escaped + "%' OR Name LIKE '%" + escaped + "%')"
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
  } catch {
    records = await queryAll(fields + " FROM PermissionSetAssignment" + idClause);
  }
  const parents = [];
  for (const record of records) {
    if (record.PermissionSet && record.PermissionSet.Id) {
      parents.push(toParent(record.PermissionSet, record));
    }
  }
  return sortParents(parents);
}

async function queryByParents(selectAndFrom, parentIds, sobject) {
  if (!parentIds.length) {
    return [];
  }
  const groups = await Promise.all(chunk(parentIds, 100).map(group => {
    let soql = selectAndFrom + " WHERE ParentId IN (" + group.map(soqlQuote).join(",") + ")";
    if (sobject) {
      soql += " AND SobjectType = " + soqlQuote(sobject);
    }
    return queryAll(soql);
  }));
  return groups.flat();
}

export async function getObjectPermissions(parentIds, sobject) {
  const fields = OLS_KEYS.map(item => item.field).join(", ");
  return queryByParents(
    "SELECT ParentId, SobjectType, " + fields + " FROM ObjectPermissions",
    parentIds,
    sobject
  );
}

export async function getFieldPermissions(parentIds, sobject) {
  return queryByParents(
    "SELECT ParentId, SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions",
    parentIds,
    sobject
  );
}

export async function getProfileObjectPermissions(parentId) {
  const fields = OLS_KEYS.map(item => item.field).join(", ");
  return queryAll(
    "SELECT ParentId, SobjectType, " + fields + " FROM ObjectPermissions WHERE ParentId = " + soqlQuote(parentId)
    + " ORDER BY SobjectType"
  );
}

export async function describeFields(sobject) {
  const describe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/" + encodeURIComponent(sobject) + "/describe");
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

export function buildMatrix({fields, parents, objectPerms, fieldPerms, sobject}) {
  const olsByParent = {};
  const olsSources = {};
  for (const item of OLS_KEYS) {
    olsSources[item.key] = [];
  }
  for (const parent of parents) {
    olsByParent[parent.id] = emptyOls();
  }
  for (const record of objectPerms || []) {
    const ols = recordToOls(record);
    olsByParent[record.ParentId] = ols;
  }

  const effectiveOls = emptyOls();
  for (const parent of parents) {
    const ols = olsByParent[parent.id] || emptyOls();
    orOls(effectiveOls, ols);
    for (const item of OLS_KEYS) {
      if (ols[item.key]) {
        olsSources[item.key].push(parent.label);
      }
    }
  }

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
      byParent: olsByParent,
      effective: effectiveOls,
      sources: olsSources
    },
    fls
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

export function matrixToCsv({mode, objectName, parents, matrix, profileOlsRows}) {
  const lines = [];
  const parentList = parents || [];

  if (profileOlsRows && profileOlsRows.length && mode === "profile") {
    lines.push(csvRow(["Object Level Security"]));
    lines.push(csvRow(["SObject", ...OLS_KEYS.map(item => item.label)]));
    for (const record of profileOlsRows) {
      const ols = recordToOls(record);
      lines.push(csvRow([record.SobjectType, ...OLS_KEYS.map(item => ols[item.key] ? "true" : "false")]));
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
  }

  return lines.join("\r\n");
}
