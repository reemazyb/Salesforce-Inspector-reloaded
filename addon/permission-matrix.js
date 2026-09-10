/* global React ReactDOM */
import {sfConn} from "./inspector.js";
/* global initButton */
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, createSpinForMethod, copyToClipboard, downloadCsvFile, getSobjectsList, applyProductionStyling} from "./utils.js";
import {
  OLS_KEYS,
  searchUsers,
  getUserById,
  listProfiles,
  searchPermissionSets,
  getPermissionSetsByIds,
  getUserAssignments,
  getObjectPermissions,
  getFieldPermissions,
  describeFields,
  getParentsForSobject,
  getSystemPermissionFields,
  getPermissionSetFlags,
  getCustomPermissionAccess,
  buildMatrix,
  buildObjectRows,
  buildUserPerms,
  buildCustomPerms,
  summarizeSnapshot,
  matrixToCsv,
  parentKindLabel
} from "./permission-matrix-data.js";

let h = React.createElement;

const MODES = [
  {key: "user", label: "User"},
  {key: "object", label: "Object"},
  {key: "profile", label: "Profile"}
];

const SECTIONS = [
  {key: "objects", label: "Objects"},
  {key: "fields", label: "Fields"},
  {key: "userPerms", label: "User permissions"},
  {key: "customPerms", label: "Custom permissions"}
];

class Model {
  constructor({sfHost, args}) {
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.reactCallback = null;
    this.errorMessage = null;
    this.infoMessage = null;
    this.loadGen = 0;

    this.mode = MODES.some(item => item.key === args.get("mode")) ? args.get("mode") : "user";
    this.section = SECTIONS.some(item => item.key === args.get("section")) ? args.get("section") : "objects";
    this.sobjects = [];
    this.sobjectLabels = {};
    this.profiles = [];
    this.userQuery = "";
    this.userResults = [];
    this.showUserResults = false;
    this.selectedUser = null;
    this.objectQuery = "";
    this.objectResults = [];
    this.showObjectResults = false;
    this.selectedObject = null;
    this.selectedProfile = null;
    this.permSetQuery = "";
    this.permSetResults = [];
    this.showPermSetResults = false;
    this.selectedParents = [];
    this.parents = [];
    this.matrix = null;
    this.objectRows = [];
    this.userPerms = [];
    this.customPerms = [];
    this.summary = null;
    this.systemPermFields = [];
    this.fieldFilter = "";
    this.objectFilter = "";
    this.permFilter = "";
    this.hideNoAccess = true;
    this.hideNonPermissionable = false;
    this.hideUngrantedUserPerms = true;

    this.userSearchTimer = null;
    this.permSetSearchTimer = null;

    applyProductionStyling(sfHost);
    this.spinFor = createSpinForMethod(this);
    this.userInfoModel = new UserInfoModel(this.spinFor.bind(this));
    document.title = "Permissions";

    this.spinFor(this.initialize(args));
  }

  didUpdate(cb) {
    if (this.reactCallback) {
      this.reactCallback(cb);
    }
  }

  async initialize(args) {
    try {
      const [sobjects, profiles, systemPermFields] = await Promise.all([
        getSobjectsList(this.sfHost),
        listProfiles(),
        getSystemPermissionFields().catch(() => [])
      ]);
      this.sobjects = sobjects || [];
      this.sobjectLabels = {};
      for (const obj of this.sobjects) {
        this.sobjectLabels[obj.name] = obj.label || obj.name;
      }
      this.profiles = profiles;
      this.systemPermFields = systemPermFields;

      const objectType = args.get("objectType");
      if (objectType) {
        this.selectedObject = this.sobjects.find(obj => obj.name === objectType) || {name: objectType, label: objectType};
        this.objectQuery = this.selectedObject.name;
      }

      const userId = args.get("userId");
      if (userId) {
        const user = await getUserById(userId);
        if (user) {
          this.selectedUser = user;
          this.userQuery = user.Name;
          this.parents = await getUserAssignments(user.Id);
        }
      }

      const profileId = args.get("profileId");
      if (profileId) {
        this.selectedProfile = this.profiles.find(profile => profile.profileId === profileId || profile.id === profileId) || null;
        if (!this.selectedProfile) {
          const found = await getPermissionSetsByIds([profileId]);
          this.selectedProfile = found[0] || null;
        }
      }

      const parentIds = (args.get("parentIds") || "").split(",").map(id => id.trim()).filter(Boolean);
      if (parentIds.length) {
        this.selectedParents = await getPermissionSetsByIds(parentIds);
      }

      await this.refreshMatrix();
    } catch (err) {
      this.errorMessage = err.message || String(err);
    }
  }

  syncUrl() {
    const args = new URLSearchParams();
    args.set("host", this.sfHost);
    args.set("mode", this.mode);
    args.set("section", this.section);
    if (this.selectedObject) {
      args.set("objectType", this.selectedObject.name);
    }
    if (this.mode === "user" && this.selectedUser) {
      args.set("userId", this.selectedUser.Id);
    }
    if (this.mode === "profile" && this.selectedProfile) {
      args.set("profileId", this.selectedProfile.profileId || this.selectedProfile.id);
    }
    if (this.mode === "object" && this.selectedParents.length) {
      args.set("parentIds", this.selectedParents.map(parent => parent.id).join(","));
    }
    history.replaceState(null, "", location.pathname + "?" + args.toString());
  }

  setMode(mode) {
    this.mode = mode;
    this.matrix = null;
    this.objectRows = [];
    this.userPerms = [];
    this.customPerms = [];
    this.summary = null;
    this.errorMessage = null;
    if (mode !== "fields") {
      this.section = this.section === "fields" && !this.selectedObject ? "objects" : this.section;
    }
    this.syncUrl();
    this.spinFor(this.refreshMatrix());
  }

  setSection(section) {
    this.section = section;
    this.syncUrl();
  }

  setUserQuery(value) {
    this.userQuery = value;
    this.showUserResults = true;
    if (this.userSearchTimer) {
      clearTimeout(this.userSearchTimer);
    }
    const term = value.trim();
    if (term.length < 2) {
      this.userResults = [];
      return;
    }
    this.userSearchTimer = setTimeout(() => {
      this.spinFor(this.runUserSearch(term));
    }, 250);
  }

  async runUserSearch(term) {
    try {
      this.userResults = await searchUsers(term);
      this.showUserResults = true;
    } catch (err) {
      this.errorMessage = err.message;
      this.userResults = [];
    }
  }

  async selectUser(user) {
    this.selectedUser = user;
    this.userQuery = user.Name;
    this.userResults = [];
    this.showUserResults = false;
    this.errorMessage = null;
    this.syncUrl();
    try {
      this.parents = await getUserAssignments(user.Id);
    } catch (err) {
      this.parents = [];
      this.errorMessage = err.message;
    }
    await this.refreshMatrix();
  }

  clearUser() {
    this.selectedUser = null;
    this.userQuery = "";
    this.parents = [];
    this.clearResults();
    this.syncUrl();
  }

  setObjectQuery(value) {
    this.objectQuery = value;
    this.showObjectResults = true;
    const term = value.trim().toLowerCase();
    if (!term) {
      this.objectResults = [];
      return;
    }
    this.objectResults = this.sobjects.filter(obj =>
      (obj.name && obj.name.toLowerCase().includes(term))
      || (obj.label && obj.label.toLowerCase().includes(term))
    ).slice(0, 25);
  }

  async selectObject(obj) {
    this.selectedObject = obj;
    this.objectQuery = obj.name;
    this.objectResults = [];
    this.showObjectResults = false;
    this.syncUrl();
    await this.refreshMatrix();
  }

  clearObject() {
    this.selectedObject = null;
    this.objectQuery = "";
    this.matrix = this.matrix ? Object.assign({}, this.matrix, {fls: []}) : null;
    if (this.section === "fields") {
      this.section = "objects";
    }
    this.syncUrl();
    this.spinFor(this.refreshMatrix());
  }

  async selectProfile(profileId) {
    this.selectedProfile = this.profiles.find(profile => profile.id === profileId) || null;
    this.syncUrl();
    await this.refreshMatrix();
  }

  setPermSetQuery(value) {
    this.permSetQuery = value;
    this.showPermSetResults = true;
    if (this.permSetSearchTimer) {
      clearTimeout(this.permSetSearchTimer);
    }
    const term = value.trim();
    if (term.length < 2) {
      this.permSetResults = [];
      return;
    }
    this.permSetSearchTimer = setTimeout(() => {
      this.spinFor(this.runPermSetSearch(term));
    }, 250);
  }

  async runPermSetSearch(term) {
    try {
      const results = await searchPermissionSets(term);
      if (this.mode === "profile") {
        this.permSetResults = results;
      } else {
        const selected = new Set(this.selectedParents.map(parent => parent.id));
        this.permSetResults = results.filter(parent => !selected.has(parent.id));
      }
      this.showPermSetResults = true;
    } catch (err) {
      this.errorMessage = err.message;
      this.permSetResults = [];
    }
  }

  async selectScopeParent(parent) {
    this.selectedProfile = parent;
    this.permSetQuery = "";
    this.permSetResults = [];
    this.showPermSetResults = false;
    this.syncUrl();
    await this.refreshMatrix();
  }

  async addParent(parent) {
    if (this.selectedParents.some(item => item.id === parent.id)) {
      return;
    }
    this.selectedParents = this.selectedParents.concat(parent);
    this.permSetResults = this.permSetResults.filter(item => item.id !== parent.id);
    this.permSetQuery = "";
    this.showPermSetResults = false;
    this.syncUrl();
    await this.refreshMatrix();
  }

  async addProfileParent(profileId) {
    const profile = this.profiles.find(item => item.id === profileId);
    if (profile) {
      await this.addParent(profile);
    }
  }

  async removeParent(parentId) {
    this.selectedParents = this.selectedParents.filter(parent => parent.id !== parentId);
    this.syncUrl();
    await this.refreshMatrix();
  }

  switchToUserMode() {
    this.mode = "user";
    this.errorMessage = null;
    this.syncUrl();
    this.spinFor(this.refreshMatrix());
  }

  canLoad() {
    if (this.mode === "user") {
      return !!this.selectedUser;
    }
    if (this.mode === "object") {
      return !!this.selectedObject;
    }
    return !!this.selectedProfile;
  }

  clearResults() {
    this.matrix = null;
    this.objectRows = [];
    this.userPerms = [];
    this.customPerms = [];
    this.summary = null;
  }

  async refreshMatrix() {
    const gen = ++this.loadGen;
    this.errorMessage = null;
    this.infoMessage = null;
    if (!this.canLoad()) {
      this.clearResults();
      return;
    }
    try {
      let parents = [];
      let objectPerms = [];
      if (this.mode === "user") {
        parents = this.parents.length ? this.parents : await getUserAssignments(this.selectedUser.Id);
        this.parents = parents;
        objectPerms = await getObjectPermissions(parents.map(parent => parent.id));
      } else if (this.mode === "object") {
        const loaded = await getParentsForSobject(this.selectedObject.name);
        if (gen !== this.loadGen) {
          return;
        }
        const extra = this.selectedParents.filter(parent => !loaded.parents.some(item => item.id === parent.id));
        parents = loaded.parents.concat(extra);
        this.parents = parents;
        objectPerms = loaded.objectPerms;
        if (extra.length) {
          const extraPerms = await getObjectPermissions(extra.map(parent => parent.id), this.selectedObject.name);
          objectPerms = objectPerms.concat(extraPerms);
        }
      } else {
        parents = [this.selectedProfile];
        this.parents = parents;
        objectPerms = await getObjectPermissions([this.selectedProfile.id]);
      }
      if (gen !== this.loadGen) {
        return;
      }

      const parentIds = parents.map(parent => parent.id);
      const fieldNames = this.systemPermFields.map(field => field.name);
      const [flagRecords, customAccess, fieldBundle] = await Promise.all([
        getPermissionSetFlags(parentIds, fieldNames),
        getCustomPermissionAccess(parentIds),
        this.selectedObject
          ? this.loadFieldBundle(parentIds, this.selectedObject.name)
          : Promise.resolve({fields: [], fieldPerms: []})
      ]);
      if (gen !== this.loadGen) {
        return;
      }

      const matrix = this.selectedObject
        ? buildMatrix({
          fields: fieldBundle.fields,
          parents,
          objectPerms: this.mode === "object" ? objectPerms : objectPerms.filter(row => row.SobjectType === this.selectedObject.name),
          fieldPerms: fieldBundle.fieldPerms,
          sobject: this.selectedObject.name,
          sobjectLabels: this.sobjectLabels
        })
        : {ols: null, fls: [], objectRows: []};

      this.objectRows = this.mode === "object"
        ? (matrix.objectRows || buildObjectRows({parents, objectPerms, sobjectLabels: this.sobjectLabels}))
        : buildObjectRows({parents, objectPerms, sobjectLabels: this.sobjectLabels});
      this.matrix = matrix;
      this.userPerms = buildUserPerms({parents, fields: this.systemPermFields, records: flagRecords});
      this.customPerms = buildCustomPerms({
        parents,
        accessRows: customAccess.accessRows,
        customPerms: customAccess.customPerms
      });
      this.summary = summarizeSnapshot({
        parents,
        objectRows: this.objectRows,
        userPerms: this.userPerms,
        customPerms: this.customPerms
      });
      if (this.selectedObject) {
        this.infoMessage = "Field list is limited to fields you can describe.";
      }
    } catch (err) {
      this.clearResults();
      this.errorMessage = err.message || String(err);
    }
  }

  async loadFieldBundle(parentIds, sobject) {
    const [fields, fieldPerms] = await Promise.all([
      describeFields(sobject),
      getFieldPermissions(parentIds, sobject)
    ]);
    return {fields, fieldPerms};
  }

  filteredObjectRows() {
    const term = this.objectFilter.trim().toLowerCase();
    return this.objectRows.filter(row => {
      if (this.hideNoAccess && !OLS_KEYS.some(item => row.effective[item.key])) {
        return false;
      }
      if (!term) {
        return true;
      }
      return row.sobject.toLowerCase().includes(term) || (row.label && row.label.toLowerCase().includes(term));
    });
  }

  filteredFls() {
    if (!this.matrix || !this.matrix.fls) {
      return [];
    }
    const term = this.fieldFilter.trim().toLowerCase();
    return this.matrix.fls.filter(field => {
      if (this.hideNonPermissionable && !field.permissionable) {
        return false;
      }
      if (this.hideNoAccess && !field.effective.read && !field.effective.edit && !field.alwaysRead) {
        return false;
      }
      if (!term) {
        return true;
      }
      return field.name.toLowerCase().includes(term) || (field.label && field.label.toLowerCase().includes(term));
    });
  }

  filteredUserPerms() {
    const term = this.permFilter.trim().toLowerCase();
    return this.userPerms.filter(perm => {
      if (this.hideUngrantedUserPerms && !perm.granted) {
        return false;
      }
      if (!term) {
        return true;
      }
      return perm.label.toLowerCase().includes(term) || perm.key.toLowerCase().includes(term);
    });
  }

  filteredCustomPerms() {
    const term = this.permFilter.trim().toLowerCase();
    if (!term) {
      return this.customPerms;
    }
    return this.customPerms.filter(perm =>
      perm.label.toLowerCase().includes(term) || perm.name.toLowerCase().includes(term)
    );
  }

  csvFileName() {
    const parts = ["permissions", this.mode];
    if (this.selectedUser) {
      parts.push(this.selectedUser.Username || this.selectedUser.Name);
    }
    if (this.selectedProfile) {
      parts.push(this.selectedProfile.label);
    }
    if (this.selectedObject) {
      parts.push(this.selectedObject.name);
    }
    return parts.join("-").replace(/[^\w.-]+/g, "_") + ".csv";
  }

  buildCsv() {
    const filteredMatrix = this.matrix
      ? Object.assign({}, this.matrix, {fls: this.filteredFls()})
      : null;
    return matrixToCsv({
      mode: this.mode,
      objectName: this.selectedObject ? this.selectedObject.name : "",
      parents: this.parents,
      matrix: filteredMatrix,
      objectRows: this.filteredObjectRows(),
      userPerms: this.hideUngrantedUserPerms ? this.userPerms.filter(item => item.granted) : this.userPerms,
      customPerms: this.customPerms
    });
  }

  exportCsv() {
    downloadCsvFile(this.buildCsv(), this.csvFileName());
  }

  copyCsv() {
    copyToClipboard(this.buildCsv());
  }

  hasExport() {
    return !!(this.objectRows.length || (this.matrix && this.matrix.fls && this.matrix.fls.length) || this.userPerms.length || this.customPerms.length);
  }
}

function accessCell(granted, always) {
  if (always) {
    return h("span", {className: "pm-cell-always", title: "Not permissionable"}, "Always");
  }
  if (granted) {
    return h("span", {className: "pm-cell-true"}, "Yes");
  }
  return h("span", {className: "pm-cell-false"}, "No");
}

function sourceText(sources) {
  return (sources || []).join(", ");
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.onModeChange = this.onModeChange.bind(this);
    this.onSectionChange = this.onSectionChange.bind(this);
    this.onUserQuery = this.onUserQuery.bind(this);
    this.onSelectUser = this.onSelectUser.bind(this);
    this.onClearUser = this.onClearUser.bind(this);
    this.onObjectQuery = this.onObjectQuery.bind(this);
    this.onSelectObject = this.onSelectObject.bind(this);
    this.onClearObject = this.onClearObject.bind(this);
    this.onSelectProfile = this.onSelectProfile.bind(this);
    this.onProfileParentChange = this.onProfileParentChange.bind(this);
    this.onPermSetQuery = this.onPermSetQuery.bind(this);
    this.onAddPermSet = this.onAddPermSet.bind(this);
    this.onSelectScopeParent = this.onSelectScopeParent.bind(this);
    this.onRemoveParent = this.onRemoveParent.bind(this);
    this.onFieldFilter = this.onFieldFilter.bind(this);
    this.onObjectFilter = this.onObjectFilter.bind(this);
    this.onPermFilter = this.onPermFilter.bind(this);
    this.onToggleHideNoAccess = this.onToggleHideNoAccess.bind(this);
    this.onToggleHideNonPermissionable = this.onToggleHideNonPermissionable.bind(this);
    this.onToggleHideUngranted = this.onToggleHideUngranted.bind(this);
    this.onExportCsv = this.onExportCsv.bind(this);
    this.onCopyCsv = this.onCopyCsv.bind(this);
    this.onSwitchToUser = this.onSwitchToUser.bind(this);
    this.onDocumentClick = this.onDocumentClick.bind(this);
  }

  componentDidMount() {
    document.addEventListener("click", this.onDocumentClick);
  }

  componentWillUnmount() {
    document.removeEventListener("click", this.onDocumentClick);
  }

  onDocumentClick() {
    let {model} = this.props;
    if (model.showUserResults || model.showObjectResults || model.showPermSetResults) {
      model.showUserResults = false;
      model.showObjectResults = false;
      model.showPermSetResults = false;
      model.didUpdate();
    }
  }

  onModeChange(e) {
    this.props.model.setMode(e.target.value);
    this.props.model.didUpdate();
  }

  onSectionChange(key) {
    this.props.model.setSection(key);
    this.props.model.didUpdate();
  }

  onUserQuery(e) {
    e.stopPropagation();
    this.props.model.setUserQuery(e.target.value);
    this.props.model.didUpdate();
  }

  onSelectUser(user) {
    this.props.model.spinFor(this.props.model.selectUser(user));
    this.props.model.didUpdate();
  }

  onClearUser() {
    this.props.model.clearUser();
    this.props.model.didUpdate();
  }

  onObjectQuery(e) {
    e.stopPropagation();
    this.props.model.setObjectQuery(e.target.value);
    this.props.model.didUpdate();
  }

  onSelectObject(obj) {
    this.props.model.spinFor(this.props.model.selectObject(obj));
    this.props.model.didUpdate();
  }

  onClearObject() {
    this.props.model.clearObject();
    this.props.model.didUpdate();
  }

  onSelectProfile(e) {
    this.props.model.spinFor(this.props.model.selectProfile(e.target.value));
    this.props.model.didUpdate();
  }

  onProfileParentChange(e) {
    if (e.target.value) {
      this.props.model.spinFor(this.props.model.addProfileParent(e.target.value));
    }
    e.target.value = "";
    this.props.model.didUpdate();
  }

  onPermSetQuery(e) {
    e.stopPropagation();
    this.props.model.setPermSetQuery(e.target.value);
    this.props.model.didUpdate();
  }

  onAddPermSet(parent) {
    this.props.model.spinFor(this.props.model.addParent(parent));
    this.props.model.didUpdate();
  }

  onSelectScopeParent(parent) {
    this.props.model.spinFor(this.props.model.selectScopeParent(parent));
    this.props.model.didUpdate();
  }

  onRemoveParent(parentId) {
    this.props.model.spinFor(this.props.model.removeParent(parentId));
    this.props.model.didUpdate();
  }

  onFieldFilter(e) {
    this.props.model.fieldFilter = e.target.value;
    this.props.model.didUpdate();
  }

  onObjectFilter(e) {
    this.props.model.objectFilter = e.target.value;
    this.props.model.didUpdate();
  }

  onPermFilter(e) {
    this.props.model.permFilter = e.target.value;
    this.props.model.didUpdate();
  }

  onToggleHideNoAccess(e) {
    this.props.model.hideNoAccess = e.target.checked;
    this.props.model.didUpdate();
  }

  onToggleHideNonPermissionable(e) {
    this.props.model.hideNonPermissionable = e.target.checked;
    this.props.model.didUpdate();
  }

  onToggleHideUngranted(e) {
    this.props.model.hideUngrantedUserPerms = e.target.checked;
    this.props.model.didUpdate();
  }

  onExportCsv() {
    this.props.model.exportCsv();
  }

  onCopyCsv() {
    this.props.model.copyCsv();
  }

  onSwitchToUser(e) {
    e.preventDefault();
    this.props.model.switchToUserMode();
    this.props.model.didUpdate();
  }

  renderDropdown(items, onPick, labelFn, keyFn) {
    if (!items.length) {
      return null;
    }
    return h("div", {className: "pm-dropdown", role: "listbox"},
      items.map(item =>
        h("button", {
          type: "button",
          key: keyFn(item),
          onClick: () => onPick(item)
        }, labelFn(item))
      )
    );
  }

  renderUserPicker(model) {
    return h("div", {className: "slds-form-element"},
      h("label", {className: "slds-form-element__label", htmlFor: "pm-user"}, "User"),
      h("div", {className: "slds-form-element__control pm-relative", onClick: e => e.stopPropagation()},
        h("input", {
          id: "pm-user",
          "data-testid": "pm-user-input",
          className: "slds-input",
          type: "search",
          placeholder: "Search name, username, email, or alias",
          value: model.userQuery,
          onChange: this.onUserQuery,
          onFocus: this.onUserQuery
        }),
        model.selectedUser
          ? h("div", {className: "pm-selected-chip"},
            h("span", {className: "slds-badge", "data-testid": "pm-selected-user"}, model.selectedUser.Username || model.selectedUser.Name),
            h("button", {className: "slds-button slds-button_neutral slds-button_small", onClick: this.onClearUser, type: "button"}, "Clear")
          )
          : null,
        model.showUserResults && model.userResults.length
          ? this.renderDropdown(
            model.userResults,
            this.onSelectUser,
            user => user.Name + " — " + user.Username + (user.IsActive ? "" : " (Inactive)"),
            user => user.Id
          )
          : null
      )
    );
  }

  renderObjectPicker(model) {
    return h("div", {className: "slds-form-element"},
      h("label", {className: "slds-form-element__label", htmlFor: "pm-object"}, "Object"),
      h("div", {className: "slds-form-element__control pm-relative", onClick: e => e.stopPropagation()},
        h("input", {
          id: "pm-object",
          "data-testid": "pm-object-input",
          className: "slds-input",
          type: "search",
          placeholder: model.mode === "user" ? "Optional. Pick an object for FLS" : "Search objects",
          value: model.objectQuery,
          onChange: this.onObjectQuery,
          onFocus: this.onObjectQuery
        }),
        model.selectedObject
          ? h("div", {className: "pm-selected-chip"},
            h("span", {className: "slds-badge", "data-testid": "pm-selected-object"}, model.selectedObject.name),
            h("button", {className: "slds-button slds-button_neutral slds-button_small", onClick: this.onClearObject, type: "button"}, "Clear")
          )
          : null,
        model.showObjectResults && model.objectResults.length
          ? this.renderDropdown(
            model.objectResults,
            this.onSelectObject,
            obj => obj.label + " (" + obj.name + ")",
            obj => obj.name
          )
          : null
      )
    );
  }

  renderProfilePicker(model) {
    return h("div", {className: "slds-form-element"},
      h("label", {className: "slds-form-element__label", htmlFor: "pm-profile"}, "Profile"),
      h("div", {className: "slds-form-element__control"},
        h("select", {
          id: "pm-profile",
          "data-testid": "pm-profile-select",
          className: "slds-select",
          value: model.selectedProfile && model.selectedProfile.kind === "profile" ? model.selectedProfile.id : "",
          onChange: this.onSelectProfile
        },
        h("option", {value: ""}, "Select a profile"),
        model.profiles.map(profile =>
          h("option", {key: profile.id, value: profile.id}, profile.label)
        )
        )
      )
    );
  }

  renderScopeSearch(model) {
    return h("div", {className: "slds-form-element"},
      h("label", {className: "slds-form-element__label", htmlFor: "pm-scope-ps"}, "Permission set"),
      h("div", {className: "slds-form-element__control pm-relative", onClick: e => e.stopPropagation()},
        h("input", {
          id: "pm-scope-ps",
          "data-testid": "pm-scope-ps-input",
          className: "slds-input",
          type: "search",
          placeholder: "Search a permission set instead of a profile",
          value: model.permSetQuery,
          onChange: this.onPermSetQuery,
          onFocus: this.onPermSetQuery
        }),
        model.selectedProfile && model.selectedProfile.kind !== "profile"
          ? h("div", {className: "pm-selected-chip"},
            h("span", {className: "slds-badge"}, parentKindLabel(model.selectedProfile.kind) + ": " + model.selectedProfile.label)
          )
          : null,
        model.showPermSetResults && model.permSetResults.length
          ? this.renderDropdown(
            model.permSetResults,
            this.onSelectScopeParent,
            parent => parent.label,
            parent => parent.id
          )
          : null
      )
    );
  }

  renderParentPicker(model) {
    return h("div", {"data-testid": "pm-parent-picker"},
      h("div", {className: "slds-grid slds-gutters_small slds-wrap"},
        h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"},
          h("div", {className: "slds-form-element"},
            h("label", {className: "slds-form-element__label", htmlFor: "pm-add-profile"}, "Add profile"),
            h("div", {className: "slds-form-element__control"},
              h("select", {id: "pm-add-profile", className: "slds-select", defaultValue: "", onChange: this.onProfileParentChange},
                h("option", {value: ""}, "Add a profile column"),
                model.profiles.map(profile =>
                  h("option", {key: profile.id, value: profile.id}, profile.label)
                )
              )
            )
          )
        ),
        h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"},
          h("div", {className: "slds-form-element"},
            h("label", {className: "slds-form-element__label", htmlFor: "pm-add-ps"}, "Add permission set"),
            h("div", {className: "slds-form-element__control pm-relative", onClick: e => e.stopPropagation()},
              h("input", {
                id: "pm-add-ps",
                className: "slds-input",
                type: "search",
                placeholder: "Search permission sets",
                value: model.permSetQuery,
                onChange: this.onPermSetQuery,
                onFocus: this.onPermSetQuery
              }),
              model.showPermSetResults && model.permSetResults.length
                ? this.renderDropdown(
                  model.permSetResults,
                  this.onAddPermSet,
                  parent => parent.label,
                  parent => parent.id
                )
                : null
            )
          )
        )
      ),
      model.selectedParents.length
        ? h("div", {className: "slds-m-top_x-small"},
          model.selectedParents.map(parent =>
            h("span", {key: parent.id, className: "slds-badge slds-m-right_xx-small slds-m-bottom_xx-small"},
              parentKindLabel(parent.kind) + ": " + parent.label + " ",
              h("button", {
                type: "button",
                className: "slds-button slds-button_icon slds-button_icon-x-small",
                title: "Remove",
                onClick: () => this.onRemoveParent(parent.id)
              }, "×")
            )
          )
        )
        : null
    );
  }

  renderSummary(model) {
    if (!model.summary) {
      return null;
    }
    const items = [
      {label: "Assignments", value: String(model.summary.assignmentCount)},
      {label: "Objects with access", value: String(model.summary.objectCount)},
      {label: "Create", value: String(model.summary.createCount)},
      {label: "User permissions", value: String(model.summary.userPermCount)},
      {label: "Custom permissions", value: String(model.summary.customPermCount)},
      {label: "View All Data", value: model.summary.viewAllData ? "Yes" : "No", warn: model.summary.viewAllData},
      {label: "Modify All Data", value: model.summary.modifyAllData ? "Yes" : "No", warn: model.summary.modifyAllData}
    ];
    return h("div", {className: "pm-summary", "data-testid": "pm-summary"},
      items.map(item =>
        h("div", {key: item.label, className: "pm-summary-card" + (item.warn ? " pm-summary-card_warn" : "")},
          h("div", {className: "pm-summary-label"}, item.label),
          h("div", {className: "pm-summary-value"}, item.value)
        )
      )
    );
  }

  renderToolbar(model) {
    return h("div", {className: "slds-grid slds-grid_align-spread slds-grid_vertical-align-center slds-wrap"},
      h("div", {className: "slds-col"},
        h("p", {className: "slds-text-body_small slds-text-color_weak"},
          "Read-only. Effective access is Profile, Permission Set, and Permission Set Group assignments. This page does not write FLS or OLS."
        )
      ),
      h("div", {className: "slds-col slds-text-align_right slds-m-left_small"},
        h("button", {
          type: "button",
          className: "slds-button slds-button_neutral",
          "data-testid": "pm-copy-csv",
          disabled: !model.hasExport(),
          onClick: this.onCopyCsv
        }, "Copy CSV"),
        h("button", {
          type: "button",
          className: "slds-button slds-button_brand",
          "data-testid": "pm-export-csv",
          disabled: !model.hasExport(),
          onClick: this.onExportCsv
        }, "Export CSV")
      )
    );
  }

  renderSections(model) {
    return h("div", {className: "slds-tabs_default slds-m-top_small", "data-testid": "pm-sections"},
      h("ul", {className: "slds-tabs_default__nav", role: "tablist"},
        SECTIONS.map(item =>
          h("li", {
            key: item.key,
            className: "slds-tabs_default__item" + (model.section === item.key ? " slds-is-active" : ""),
            title: item.label,
            role: "presentation"
          },
          h("a", {
            className: "slds-tabs_default__link",
            href: "#",
            role: "tab",
            "data-testid": "pm-section-" + item.key,
            "aria-selected": model.section === item.key ? "true" : "false",
            onClick: e => {
              e.preventDefault();
              this.onSectionChange(item.key);
            }
          }, item.label)
          )
        )
      )
    );
  }

  renderObjectTable(model) {
    const rows = model.filteredObjectRows();
    const isObjectMode = model.mode === "object";
    if (!model.canLoad()) {
      return h("p", {"data-testid": "pm-empty"}, this.emptyMessage(model));
    }
    if (!rows.length) {
      return h("p", {"data-testid": "pm-empty"}, "No object permissions match the filter.");
    }
    return h("div", {},
      h("div", {className: "slds-grid slds-grid_align-spread slds-grid_vertical-align-center slds-m-bottom_x-small slds-wrap"},
        h("input", {
          className: "slds-input pm-filter",
          type: "search",
          "data-testid": "pm-object-filter",
          placeholder: "Filter objects",
          value: model.objectFilter,
          onChange: this.onObjectFilter
        }),
        h("label", {className: "slds-checkbox_toggle"},
          h("span", {className: "slds-form-element__label"}, "Hide no access"),
          h("input", {type: "checkbox", checked: model.hideNoAccess, onChange: this.onToggleHideNoAccess}),
          h("span", {className: "slds-checkbox_faux_container"},
            h("span", {className: "slds-checkbox_faux"}),
            h("span", {className: "slds-checkbox_on"}, "On"),
            h("span", {className: "slds-checkbox_off"}, "Off")
          )
        )
      ),
      h("p", {className: "slds-text-body_small slds-m-bottom_x-small"}, rows.length + " of " + model.objectRows.length + " objects"),
      h("div", {className: "pm-table-wrap"},
        h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped", "data-testid": "pm-ols-table"},
          h("thead", {},
            isObjectMode
              ? h("tr", {},
                h("th", {scope: "col"}, "Source"),
                OLS_KEYS.map(item => h("th", {key: item.key, scope: "col"}, item.label))
              )
              : h("tr", {},
                h("th", {scope: "col"}, "Object"),
                h("th", {scope: "col"}, "Label"),
                OLS_KEYS.map(item => h("th", {key: item.key, scope: "col"}, item.label))
              )
          ),
          h("tbody", {},
            isObjectMode
              ? (rows[0] ? model.parents.map(parent => {
                const ols = rows[0].byParent[parent.id] || {};
                return h("tr", {key: parent.id},
                  h("th", {scope: "row"}, parentKindLabel(parent.kind) + ": " + parent.label),
                  OLS_KEYS.map(item => h("td", {key: item.key}, accessCell(!!ols[item.key], false)))
                );
              }) : null)
              : rows.map(row =>
                h("tr", {key: row.sobject},
                  h("th", {scope: "row"}, row.sobject),
                  h("td", {}, row.label),
                  OLS_KEYS.map(item =>
                    h("td", {key: item.key, title: sourceText(row.sources[item.key])}, accessCell(row.effective[item.key], false))
                  )
                )
              )
          )
        )
      )
    );
  }

  renderFlsTable(model) {
    if (!model.selectedObject) {
      return h("p", {"data-testid": "pm-empty"}, "Pick an object to see field permissions.");
    }
    if (!model.matrix) {
      return h("p", {"data-testid": "pm-empty"}, this.emptyMessage(model));
    }
    const rows = model.filteredFls();
    const isObjectMode = model.mode === "object";
    return h("div", {},
      h("div", {className: "slds-grid slds-wrap slds-grid_vertical-align-center slds-m-bottom_x-small"},
        h("input", {
          className: "slds-input pm-filter slds-m-right_small",
          type: "search",
          "data-testid": "pm-field-filter",
          placeholder: "Filter fields",
          value: model.fieldFilter,
          onChange: this.onFieldFilter
        }),
        h("label", {className: "slds-checkbox_toggle slds-m-right_small"},
          h("span", {className: "slds-form-element__label"}, "Hide no access"),
          h("input", {type: "checkbox", checked: model.hideNoAccess, onChange: this.onToggleHideNoAccess}),
          h("span", {className: "slds-checkbox_faux_container"},
            h("span", {className: "slds-checkbox_faux"}),
            h("span", {className: "slds-checkbox_on"}, "On"),
            h("span", {className: "slds-checkbox_off"}, "Off")
          )
        ),
        h("label", {className: "slds-checkbox_toggle"},
          h("span", {className: "slds-form-element__label"}, "Hide non-permissionable"),
          h("input", {type: "checkbox", checked: model.hideNonPermissionable, onChange: this.onToggleHideNonPermissionable}),
          h("span", {className: "slds-checkbox_faux_container"},
            h("span", {className: "slds-checkbox_faux"}),
            h("span", {className: "slds-checkbox_on"}, "On"),
            h("span", {className: "slds-checkbox_off"}, "Off")
          )
        )
      ),
      h("p", {className: "slds-text-body_small slds-m-bottom_x-small"}, rows.length + " of " + model.matrix.fls.length + " fields"),
      h("div", {className: "pm-table-wrap"},
        h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped", "data-testid": "pm-fls-table"},
          h("thead", {},
            isObjectMode
              ? [
                h("tr", {key: "h1"},
                  h("th", {scope: "col", className: "pm-sticky-corner"}, "Field"),
                  h("th", {scope: "col"}, "Label"),
                  model.parents.map(parent =>
                    h("th", {key: parent.id, scope: "col", colSpan: 2}, parent.label)
                  )
                ),
                h("tr", {key: "h2", className: "pm-subhead"},
                  h("th", {scope: "col", className: "pm-sticky-corner"}, ""),
                  h("th", {scope: "col"}, ""),
                  model.parents.flatMap(parent => [
                    h("th", {key: parent.id + "-r", scope: "col"}, "Read"),
                    h("th", {key: parent.id + "-e", scope: "col"}, "Edit")
                  ])
                )
              ]
              : h("tr", {},
                h("th", {scope: "col"}, "Field"),
                h("th", {scope: "col"}, "Label"),
                h("th", {scope: "col"}, "Type"),
                h("th", {scope: "col"}, "Read"),
                h("th", {scope: "col"}, "Edit"),
                h("th", {scope: "col"}, "Read source"),
                h("th", {scope: "col"}, "Edit source")
              )
          ),
          h("tbody", {},
            rows.map(field =>
              isObjectMode
                ? h("tr", {key: field.name},
                  h("th", {scope: "row"}, field.name),
                  h("td", {}, field.label),
                  model.parents.flatMap(parent => {
                    const cell = field.byParent[parent.id] || {read: false, edit: false};
                    return [
                      h("td", {key: parent.id + "-r"}, accessCell(cell.read, field.alwaysRead)),
                      h("td", {key: parent.id + "-e"}, accessCell(cell.edit, field.alwaysEdit))
                    ];
                  })
                )
                : h("tr", {key: field.name},
                  h("th", {scope: "row"}, field.name),
                  h("td", {}, field.label),
                  h("td", {}, field.type),
                  h("td", {}, accessCell(field.effective.read, field.alwaysRead)),
                  h("td", {}, accessCell(field.effective.edit, field.alwaysEdit)),
                  h("td", {}, sourceText(field.sources.read)),
                  h("td", {}, sourceText(field.sources.edit))
                )
            )
          )
        )
      )
    );
  }

  renderUserPermTable(model) {
    if (!model.canLoad()) {
      return h("p", {"data-testid": "pm-empty"}, this.emptyMessage(model));
    }
    const rows = model.filteredUserPerms();
    return h("div", {},
      h("div", {className: "slds-grid slds-grid_vertical-align-center slds-m-bottom_x-small slds-wrap"},
        h("input", {
          className: "slds-input pm-filter slds-m-right_small",
          type: "search",
          "data-testid": "pm-perm-filter",
          placeholder: "Filter user permissions",
          value: model.permFilter,
          onChange: this.onPermFilter
        }),
        h("label", {className: "slds-checkbox_toggle"},
          h("span", {className: "slds-form-element__label"}, "Granted only"),
          h("input", {type: "checkbox", checked: model.hideUngrantedUserPerms, onChange: this.onToggleHideUngranted}),
          h("span", {className: "slds-checkbox_faux_container"},
            h("span", {className: "slds-checkbox_faux"}),
            h("span", {className: "slds-checkbox_on"}, "On"),
            h("span", {className: "slds-checkbox_off"}, "Off")
          )
        )
      ),
      h("p", {className: "slds-text-body_small slds-m-bottom_x-small"}, rows.length + " of " + model.userPerms.length + " user permissions"),
      rows.length
        ? h("div", {className: "pm-table-wrap"},
          h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped", "data-testid": "pm-userperm-table"},
            h("thead", {},
              h("tr", {},
                h("th", {scope: "col"}, "Permission"),
                h("th", {scope: "col"}, "API name"),
                h("th", {scope: "col"}, "Granted"),
                h("th", {scope: "col"}, "Granted by")
              )
            ),
            h("tbody", {},
              rows.map(perm =>
                h("tr", {key: perm.key},
                  h("th", {scope: "row"}, perm.label),
                  h("td", {}, perm.key),
                  h("td", {}, accessCell(perm.granted, false)),
                  h("td", {}, sourceText(perm.sources))
                )
              )
            )
          )
        )
        : h("p", {"data-testid": "pm-empty"}, "No user permissions match the filter.")
    );
  }

  renderCustomPermTable(model) {
    if (!model.canLoad()) {
      return h("p", {"data-testid": "pm-empty"}, this.emptyMessage(model));
    }
    const rows = model.filteredCustomPerms();
    return h("div", {},
      h("input", {
        className: "slds-input pm-filter slds-m-bottom_x-small",
        type: "search",
        placeholder: "Filter custom permissions",
        value: model.permFilter,
        onChange: this.onPermFilter
      }),
      rows.length
        ? h("div", {className: "pm-table-wrap"},
          h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped", "data-testid": "pm-customperm-table"},
            h("thead", {},
              h("tr", {},
                h("th", {scope: "col"}, "Label"),
                h("th", {scope: "col"}, "API name"),
                h("th", {scope: "col"}, "Granted by")
              )
            ),
            h("tbody", {},
              rows.map(perm =>
                h("tr", {key: perm.key},
                  h("th", {scope: "row"}, perm.label),
                  h("td", {}, perm.name),
                  h("td", {}, sourceText(perm.sources))
                )
              )
            )
          )
        )
        : h("p", {"data-testid": "pm-empty"}, "No custom permissions granted.")
    );
  }

  emptyMessage(model) {
    if (model.mode === "user") {
      return "Select a user to see effective object access, user permissions, and custom permissions.";
    }
    if (model.mode === "object") {
      return "Select an object to see which profiles and permission sets grant OLS. Add extra columns if you need them.";
    }
    return "Select a profile or permission set to see its object, user, and custom permissions.";
  }

  renderBody(model) {
    if (model.section === "fields") {
      return this.renderFlsTable(model);
    }
    if (model.section === "userPerms") {
      return this.renderUserPermTable(model);
    }
    if (model.section === "customPerms") {
      return this.renderCustomPermTable(model);
    }
    return this.renderObjectTable(model);
  }

  render() {
    let {model} = this.props;
    return h("div", {"data-testid": "pm-page"},
      h(PageHeader, {
        pageTitle: "Permissions",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium"},
          h("div", {className: "slds-card__body slds-card__body_inner"},
            model.errorMessage
              ? h("div", {className: "slds-notify slds-notify_alert slds-alert_error slds-m-bottom_small", role: "alert", "data-testid": "pm-error"},
                h("span", {}, model.errorMessage)
              )
              : null,
            model.infoMessage
              ? h("div", {className: "slds-notify slds-notify_alert slds-alert_offline slds-m-bottom_small", role: "status", "data-testid": "pm-info"},
                h("span", {}, model.infoMessage)
              )
              : null,
            h("fieldset", {className: "slds-form-element slds-m-bottom_small"},
              h("legend", {className: "slds-form-element__legend slds-form-element__label"}, "Lens"),
              h("div", {className: "slds-form-element__control"},
                h("div", {className: "slds-radio_button-group", "data-testid": "pm-modes"},
                  MODES.map(item =>
                    h("span", {key: item.key, className: "slds-button slds-radio_button"},
                      h("input", {
                        type: "radio",
                        id: "pm-mode-" + item.key,
                        name: "pm-mode",
                        value: item.key,
                        "data-testid": "pm-mode-" + item.key,
                        checked: model.mode === item.key,
                        onChange: this.onModeChange
                      }),
                      h("label", {className: "slds-radio_button__label", htmlFor: "pm-mode-" + item.key},
                        h("span", {className: "slds-radio_faux"}, item.label)
                      )
                    )
                  )
                )
              )
            ),
            h("div", {className: "slds-grid slds-gutters_small slds-wrap"},
              model.mode === "user"
                ? h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"}, this.renderUserPicker(model))
                : null,
              model.mode === "profile"
                ? h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"}, this.renderProfilePicker(model))
                : null,
              model.mode === "profile"
                ? h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"}, this.renderScopeSearch(model))
                : null,
              h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"}, this.renderObjectPicker(model))
            ),
            model.mode === "object"
              ? h("div", {className: "slds-m-top_small"},
                this.renderParentPicker(model),
                h("p", {className: "slds-text-body_small slds-m-top_x-small"},
                  h("a", {href: "#", onClick: this.onSwitchToUser, "data-testid": "pm-switch-user"}, "Switch to User"),
                  " to see effective permissions for a selected user on this object."
                )
              )
              : null,
            model.mode === "user" && model.parents.length
              ? h("p", {className: "slds-text-body_small slds-m-top_small", "data-testid": "pm-assignments"},
                "Assignments: " + model.parents.map(parent => parentKindLabel(parent.kind) + ": " + parent.label).join(" · ")
              )
              : null,
            h("div", {className: "slds-m-top_small"}, this.renderToolbar(model))
          )
        ),
        this.renderSummary(model),
        h("div", {className: "slds-card slds-m-around_medium"},
          h("div", {className: "slds-card__body slds-card__body_inner"},
            this.renderSections(model),
            h("div", {className: "slds-m-top_small", "data-testid": "pm-section-body"}, this.renderBody(model))
          )
        )
      )
    );
  }
}

{
  let args = new URLSearchParams(location.search);
  let sfHost = args.get("host");
  let hash = new URLSearchParams(location.hash);
  if (!sfHost && hash) {
    const instanceUrl = hash.get("instance_url");
    if (instanceUrl) {
      sfHost = decodeURIComponent(instanceUrl).replace(/^https?:\/\//i, "");
    }
  }
  initButton(sfHost, true);
  sfConn.getSession(sfHost).then(() => {
    let root = document.getElementById("root");
    let model = new Model({sfHost, args});
    model.reactCallback = cb => {
      ReactDOM.render(h(App, {model}), root, cb);
    };
    ReactDOM.render(h(App, {model}), root);
  });
}
