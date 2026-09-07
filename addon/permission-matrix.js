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
  getProfileObjectPermissions,
  describeFields,
  buildMatrix,
  matrixToCsv,
  parentKindLabel
} from "./permission-matrix-data.js";

let h = React.createElement;

const MODES = [
  {key: "user", label: "User"},
  {key: "object", label: "Object"},
  {key: "profile", label: "Profile"}
];

class Model {
  constructor({sfHost, args}) {
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.reactCallback = null;
    this.errorMessage = null;
    this.loadGen = 0;

    this.mode = MODES.some(item => item.key === args.get("mode")) ? args.get("mode") : "user";
    this.sobjects = [];
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
    this.profileQuery = "";
    this.permSetQuery = "";
    this.permSetResults = [];
    this.selectedParents = [];
    this.parents = [];
    this.matrix = null;
    this.profileOlsRows = null;
    this.fieldFilter = "";
    this.objectFilter = "";
    this.hideNoAccess = false;
    this.hideNonPermissionable = false;

    this.userSearchTimer = null;
    this.permSetSearchTimer = null;

    applyProductionStyling(sfHost);
    this.spinFor = createSpinForMethod(this);
    this.userInfoModel = new UserInfoModel(this.spinFor.bind(this));
    document.title = "Permission Matrix";

    this.spinFor(this.initialize(args));
  }

  didUpdate(cb) {
    if (this.reactCallback) {
      this.reactCallback(cb);
    }
  }

  async initialize(args) {
    this.sobjects = await getSobjectsList(this.sfHost);
    this.profiles = await listProfiles();

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
  }

  syncUrl() {
    const args = new URLSearchParams();
    args.set("host", this.sfHost);
    args.set("mode", this.mode);
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
    this.profileOlsRows = null;
    this.errorMessage = null;
    this.syncUrl();
    this.spinFor(this.refreshMatrix());
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
    this.matrix = null;
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
    this.matrix = null;
    this.syncUrl();
  }

  async selectProfile(profileId) {
    this.selectedProfile = this.profiles.find(profile => profile.id === profileId) || null;
    this.syncUrl();
    await this.refreshMatrix();
  }

  setPermSetQuery(value) {
    this.permSetQuery = value;
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
      const selected = new Set(this.selectedParents.map(parent => parent.id));
      this.permSetResults = results.filter(parent => !selected.has(parent.id));
    } catch (err) {
      this.errorMessage = err.message;
      this.permSetResults = [];
    }
  }

  async addParent(parent) {
    if (this.selectedParents.some(item => item.id === parent.id)) {
      return;
    }
    this.selectedParents = this.selectedParents.concat(parent);
    this.permSetResults = this.permSetResults.filter(item => item.id !== parent.id);
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
    this.matrix = null;
    this.profileOlsRows = null;
    this.syncUrl();
  }

  canLoadMatrix() {
    if (this.mode === "user") {
      return !!(this.selectedUser && this.selectedObject);
    }
    if (this.mode === "object") {
      return !!(this.selectedObject && this.selectedParents.length);
    }
    if (this.mode === "profile") {
      return !!this.selectedProfile;
    }
    return false;
  }

  async refreshMatrix() {
    const gen = ++this.loadGen;
    this.errorMessage = null;
    if (!this.canLoadMatrix()) {
      this.matrix = null;
      if (this.mode !== "profile") {
        this.profileOlsRows = null;
      }
      return;
    }
    try {
      if (this.mode === "user") {
        const parents = this.parents.length ? this.parents : await getUserAssignments(this.selectedUser.Id);
        if (gen !== this.loadGen) {
          return;
        }
        this.parents = parents;
        this.profileOlsRows = null;
        this.matrix = await this.loadObjectMatrix(parents, this.selectedObject.name, gen);
        return;
      }
      if (this.mode === "object") {
        this.parents = this.selectedParents;
        this.profileOlsRows = null;
        this.matrix = await this.loadObjectMatrix(this.selectedParents, this.selectedObject.name, gen);
        return;
      }
      const parent = this.selectedProfile;
      this.parents = [parent];
      this.profileOlsRows = await getProfileObjectPermissions(parent.id);
      if (gen !== this.loadGen) {
        return;
      }
      if (this.selectedObject) {
        this.matrix = await this.loadObjectMatrix([parent], this.selectedObject.name, gen);
      } else {
        this.matrix = null;
      }
    } catch (err) {
      if (gen !== this.loadGen) {
        return;
      }
      this.matrix = null;
      this.profileOlsRows = null;
      this.errorMessage = err.message;
    }
  }

  async loadObjectMatrix(parents, sobject, gen) {
    const parentIds = parents.map(parent => parent.id);
    const [fields, objectPerms, fieldPerms] = await Promise.all([
      describeFields(sobject),
      getObjectPermissions(parentIds, sobject),
      getFieldPermissions(parentIds, sobject)
    ]);
    if (gen !== this.loadGen) {
      return this.matrix;
    }
    return buildMatrix({fields, parents, objectPerms, fieldPerms, sobject});
  }

  filteredFls() {
    if (!this.matrix) {
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
      return field.name.toLowerCase().includes(term) || String(field.label).toLowerCase().includes(term);
    });
  }

  filteredProfileOls() {
    const rows = this.profileOlsRows || [];
    const term = this.objectFilter.trim().toLowerCase();
    if (!term) {
      return rows;
    }
    return rows.filter(row => String(row.SobjectType).toLowerCase().includes(term));
  }

  csvFileName() {
    const parts = ["permission-matrix", this.mode];
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

  exportCsv() {
    const csv = matrixToCsv({
      mode: this.mode,
      objectName: this.selectedObject ? this.selectedObject.name : "",
      parents: this.parents,
      matrix: this.matrix,
      profileOlsRows: this.filteredProfileOls()
    });
    downloadCsvFile(csv, this.csvFileName());
  }

  copyCsv() {
    const csv = matrixToCsv({
      mode: this.mode,
      objectName: this.selectedObject ? this.selectedObject.name : "",
      parents: this.parents,
      matrix: this.matrix,
      profileOlsRows: this.filteredProfileOls()
    });
    copyToClipboard(csv);
  }

  hasExport() {
    return !!(this.matrix || (this.profileOlsRows && this.profileOlsRows.length));
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

class App extends React.Component {
  constructor(props) {
    super(props);
    this.onModeChange = this.onModeChange.bind(this);
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
    this.onRemoveParent = this.onRemoveParent.bind(this);
    this.onFieldFilter = this.onFieldFilter.bind(this);
    this.onObjectFilter = this.onObjectFilter.bind(this);
    this.onToggleHideNoAccess = this.onToggleHideNoAccess.bind(this);
    this.onToggleHideNonPermissionable = this.onToggleHideNonPermissionable.bind(this);
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
    if (model.showUserResults || model.showObjectResults) {
      model.showUserResults = false;
      model.showObjectResults = false;
      model.didUpdate();
    }
  }

  onModeChange(e) {
    let {model} = this.props;
    model.setMode(e.target.value);
    model.didUpdate();
  }

  onUserQuery(e) {
    e.stopPropagation();
    let {model} = this.props;
    model.setUserQuery(e.target.value);
    model.didUpdate();
  }

  onSelectUser(user) {
    let {model} = this.props;
    model.spinFor(model.selectUser(user));
    model.didUpdate();
  }

  onClearUser() {
    let {model} = this.props;
    model.clearUser();
    model.didUpdate();
  }

  onObjectQuery(e) {
    e.stopPropagation();
    let {model} = this.props;
    model.setObjectQuery(e.target.value);
    model.didUpdate();
  }

  onSelectObject(obj) {
    let {model} = this.props;
    model.spinFor(model.selectObject(obj));
    model.didUpdate();
  }

  onClearObject() {
    let {model} = this.props;
    model.clearObject();
    model.didUpdate();
  }

  onSelectProfile(e) {
    let {model} = this.props;
    model.spinFor(model.selectProfile(e.target.value));
    model.didUpdate();
  }

  onProfileParentChange(e) {
    let {model} = this.props;
    if (e.target.value) {
      model.spinFor(model.addProfileParent(e.target.value));
    }
    e.target.value = "";
    model.didUpdate();
  }

  onPermSetQuery(e) {
    let {model} = this.props;
    model.setPermSetQuery(e.target.value);
    model.didUpdate();
  }

  onAddPermSet(parent) {
    let {model} = this.props;
    model.spinFor(model.addParent(parent));
    model.didUpdate();
  }

  onRemoveParent(parentId) {
    let {model} = this.props;
    model.spinFor(model.removeParent(parentId));
    model.didUpdate();
  }

  onFieldFilter(e) {
    let {model} = this.props;
    model.fieldFilter = e.target.value;
    model.didUpdate();
  }

  onObjectFilter(e) {
    let {model} = this.props;
    model.objectFilter = e.target.value;
    model.didUpdate();
  }

  onToggleHideNoAccess(e) {
    let {model} = this.props;
    model.hideNoAccess = e.target.checked;
    model.didUpdate();
  }

  onToggleHideNonPermissionable(e) {
    let {model} = this.props;
    model.hideNonPermissionable = e.target.checked;
    model.didUpdate();
  }

  onExportCsv() {
    this.props.model.exportCsv();
  }

  onCopyCsv() {
    this.props.model.copyCsv();
  }

  onSwitchToUser(e) {
    e.preventDefault();
    let {model} = this.props;
    model.switchToUserMode();
    model.didUpdate();
  }

  renderUserPicker(model) {
    return h("div", {className: "slds-form-element"},
      h("label", {className: "slds-form-element__label", htmlFor: "pm-user"}, "User"),
      h("div", {className: "slds-form-element__control pm-relative", onClick: e => e.stopPropagation()},
        h("input", {
          id: "pm-user",
          className: "slds-input",
          type: "search",
          placeholder: "Search name, username, email, or alias",
          value: model.userQuery,
          onChange: this.onUserQuery,
          onFocus: this.onUserQuery
        }),
        model.selectedUser
          ? h("div", {className: "pm-selected-chip"},
            h("span", {className: "slds-badge"}, model.selectedUser.Username || model.selectedUser.Name),
            h("button", {className: "slds-button slds-button_neutral slds-button_small", onClick: this.onClearUser, type: "button"}, "Clear")
          )
          : null,
        model.showUserResults && model.userResults.length
          ? h("div", {className: "pm-dropdown", role: "listbox"},
            model.userResults.map(user =>
              h("button", {
                type: "button",
                key: user.Id,
                onClick: () => this.onSelectUser(user)
              },
              user.Name + " — " + user.Username + (user.IsActive ? "" : " (Inactive)")
              )
            )
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
          className: "slds-input",
          type: "search",
          placeholder: "Search object API name or label",
          value: model.objectQuery,
          onChange: this.onObjectQuery,
          onFocus: this.onObjectQuery
        }),
        model.selectedObject
          ? h("div", {className: "pm-selected-chip"},
            h("span", {className: "slds-badge"}, model.selectedObject.name + (model.selectedObject.label ? " (" + model.selectedObject.label + ")" : "")),
            h("button", {className: "slds-button slds-button_neutral slds-button_small", onClick: this.onClearObject, type: "button"}, "Clear")
          )
          : null,
        model.showObjectResults && model.objectResults.length
          ? h("div", {className: "pm-dropdown", role: "listbox"},
            model.objectResults.map(obj =>
              h("button", {
                type: "button",
                key: obj.name,
                onClick: () => this.onSelectObject(obj)
              },
              obj.name + (obj.label ? " (" + obj.label + ")" : "")
              )
            )
          )
          : null
      )
    );
  }

  renderProfilePicker(model) {
    return h("div", {className: "slds-form-element"},
      h("label", {className: "slds-form-element__label", htmlFor: "pm-profile"}, "Profile"),
      h("div", {className: "slds-form-element__control"},
        h("div", {className: "slds-select_container"},
          h("select", {
            id: "pm-profile",
            className: "slds-select",
            value: model.selectedProfile ? model.selectedProfile.id : "",
            onChange: this.onSelectProfile
          },
          h("option", {value: ""}, "Select a profile"),
          model.profiles.map(profile =>
            h("option", {key: profile.id, value: profile.id}, profile.label)
          )
          )
        )
      )
    );
  }

  renderParentPicker(model) {
    return h("div", {className: "slds-grid slds-gutters_small slds-wrap"},
      h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"},
        h("div", {className: "slds-form-element"},
          h("label", {className: "slds-form-element__label", htmlFor: "pm-add-profile"}, "Add Profile"),
          h("div", {className: "slds-form-element__control"},
            h("div", {className: "slds-select_container"},
              h("select", {id: "pm-add-profile", className: "slds-select", value: "", onChange: this.onProfileParentChange},
                h("option", {value: ""}, "Select a profile to add"),
                model.profiles
                  .filter(profile => !model.selectedParents.some(parent => parent.id === profile.id))
                  .map(profile => h("option", {key: profile.id, value: profile.id}, profile.label))
              )
            )
          )
        )
      ),
      h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"},
        h("div", {className: "slds-form-element"},
          h("label", {className: "slds-form-element__label", htmlFor: "pm-permset"}, "Add Permission Set or Group"),
          h("div", {className: "slds-form-element__control"},
            h("input", {
              id: "pm-permset",
              className: "slds-input",
              type: "search",
              placeholder: "Search permission sets",
              value: model.permSetQuery,
              onChange: this.onPermSetQuery
            }),
            model.permSetResults.length
              ? h("div", {className: "pm-picker-list slds-m-top_xx-small"},
                model.permSetResults.map(parent =>
                  h("button", {
                    type: "button",
                    key: parent.id,
                    className: "slds-button slds-button_neutral slds-m-around_xxx-small",
                    onClick: () => this.onAddPermSet(parent)
                  }, parentKindLabel(parent.kind) + ": " + parent.label)
                )
              )
              : null
          )
        )
      ),
      model.selectedParents.length
        ? h("div", {className: "slds-col slds-size_1-of-1 slds-m-top_x-small"},
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

  renderToolbar(model) {
    return h("div", {className: "slds-grid slds-grid_align-spread slds-grid_vertical-align-center slds-wrap"},
      h("div", {className: "slds-col"},
        h("p", {className: "slds-text-body_small slds-text-color_weak"},
          "Read-only. Object and field permissions come from Profile, Permission Set, and Permission Set Group assignments. This tool does not write FLS or OLS. See issue #688 for copy/paste editing."
        )
      ),
      h("div", {className: "slds-col slds-text-align_right slds-m-left_small"},
        h("button", {
          type: "button",
          className: "slds-button slds-button_neutral",
          disabled: !model.hasExport(),
          onClick: this.onCopyCsv
        }, "Copy CSV"),
        h("button", {
          type: "button",
          className: "slds-button slds-button_brand",
          disabled: !model.hasExport(),
          onClick: this.onExportCsv
        }, "Export CSV")
      )
    );
  }

  renderOlsTable(model) {
    if (model.mode === "profile") {
      const rows = model.filteredProfileOls();
      return h("div", {className: "slds-card slds-m-around_medium"},
        h("div", {className: "slds-card__header slds-grid slds-grid_align-spread slds-grid_vertical-align-center"},
          h("h3", {className: "slds-card__header-title"}, "Object permissions"),
          h("div", {className: "slds-form-element"},
            h("input", {
              className: "slds-input",
              type: "search",
              placeholder: "Filter objects",
              value: model.objectFilter,
              onChange: this.onObjectFilter
            })
          )
        ),
        h("div", {className: "slds-card__body slds-card__body_inner"},
          rows.length
            ? h("div", {className: "pm-table-wrap"},
              h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped"},
                h("thead", {},
                  h("tr", {},
                    h("th", {scope: "col"}, "Object"),
                    OLS_KEYS.map(item => h("th", {key: item.key, scope: "col"}, item.label))
                  )
                ),
                h("tbody", {},
                  rows.map(record =>
                    h("tr", {key: record.SobjectType},
                      h("th", {scope: "row"}, record.SobjectType),
                      OLS_KEYS.map(item =>
                        h("td", {key: item.key}, accessCell(!!record[item.field], false))
                      )
                    )
                  )
                )
              )
            )
            : h("p", {}, model.selectedProfile ? "No object permissions found for this profile." : "Select a profile.")
        )
      );
    }

    if (!model.matrix) {
      return null;
    }
    const parents = model.parents;
    return h("div", {className: "slds-card slds-m-around_medium"},
      h("div", {className: "slds-card__header"},
        h("h3", {className: "slds-card__header-title"}, "Object permissions" + (model.selectedObject ? " — " + model.selectedObject.name : ""))
      ),
      h("div", {className: "slds-card__body slds-card__body_inner"},
        h("div", {className: "pm-table-wrap"},
          h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped"},
            h("thead", {},
              h("tr", {},
                h("th", {scope: "col"}, "Source"),
                OLS_KEYS.map(item => h("th", {key: item.key, scope: "col"}, item.label))
              )
            ),
            h("tbody", {},
              model.mode !== "object"
                ? h("tr", {},
                  h("th", {scope: "row"}, "Effective"),
                  OLS_KEYS.map(item =>
                    h("td", {key: item.key, title: (model.matrix.ols.sources[item.key] || []).join(", ")},
                      accessCell(model.matrix.ols.effective[item.key], false)
                    )
                  )
                )
                : null,
              parents.map(parent => {
                const ols = model.matrix.ols.byParent[parent.id] || {};
                return h("tr", {key: parent.id},
                  h("th", {scope: "row"}, parentKindLabel(parent.kind) + ": " + parent.label),
                  OLS_KEYS.map(item => h("td", {key: item.key}, accessCell(!!ols[item.key], false)))
                );
              })
            )
          )
        )
      )
    );
  }

  renderFlsTable(model) {
    if (!model.matrix) {
      return h("div", {className: "slds-card slds-m-around_medium"},
        h("div", {className: "slds-card__body slds-card__body_inner"},
          h("p", {}, this.emptyMessage(model))
        )
      );
    }
    const rows = model.filteredFls();
    const isObjectMode = model.mode === "object";
    return h("div", {className: "slds-card slds-m-around_medium"},
      h("div", {className: "slds-card__header slds-grid slds-wrap slds-grid_vertical-align-center"},
        h("h3", {className: "slds-card__header-title slds-m-right_small"}, "Field permissions"),
        h("div", {className: "slds-col slds-grid slds-grid_vertical-align-center slds-wrap"},
          h("input", {
            className: "slds-input slds-m-right_small",
            type: "search",
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
        )
      ),
      h("div", {className: "slds-card__body slds-card__body_inner"},
        h("p", {className: "slds-text-body_small slds-m-bottom_x-small"}, rows.length + " of " + model.matrix.fls.length + " fields"),
        h("div", {className: "pm-table-wrap"},
          h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped"},
            h("thead", {},
              isObjectMode
                ? h("tr", {},
                  h("th", {scope: "col"}, "Field"),
                  h("th", {scope: "col"}, "Label"),
                  model.parents.map(parent =>
                    h("th", {key: parent.id, scope: "col", colSpan: 2}, parent.label)
                  )
                )
                : h("tr", {},
                  h("th", {scope: "col"}, "Field"),
                  h("th", {scope: "col"}, "Label"),
                  h("th", {scope: "col"}, "Type"),
                  h("th", {scope: "col"}, "Read"),
                  h("th", {scope: "col"}, "Edit"),
                  h("th", {scope: "col"}, "Read source"),
                  h("th", {scope: "col"}, "Edit source")
                ),
              isObjectMode
                ? h("tr", {},
                  h("th", {scope: "col"}, ""),
                  h("th", {scope: "col"}, ""),
                  model.parents.flatMap(parent => [
                    h("th", {key: parent.id + "-r", scope: "col"}, "Read"),
                    h("th", {key: parent.id + "-e", scope: "col"}, "Edit")
                  ])
                )
                : null
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
                    h("td", {}, (field.sources.read || []).join(", ")),
                    h("td", {}, (field.sources.edit || []).join(", "))
                  )
              )
            )
          )
        )
      )
    );
  }

  emptyMessage(model) {
    if (model.mode === "user") {
      return "Select a user and an object to see effective OLS and FLS.";
    }
    if (model.mode === "object") {
      return "Select an object and at least one profile or permission set.";
    }
    return "Select a profile to see object permissions. Optionally select an object for FLS.";
  }

  render() {
    let {model} = this.props;
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Permission Matrix",
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
              ? h("div", {className: "slds-notify slds-notify_alert slds-alert_error slds-m-bottom_small", role: "alert"},
                h("span", {}, model.errorMessage)
              )
              : null,
            h("fieldset", {className: "slds-form-element slds-m-bottom_small"},
              h("legend", {className: "slds-form-element__legend slds-form-element__label"}, "Mode"),
              h("div", {className: "slds-form-element__control"},
                h("div", {className: "slds-radio_button-group"},
                  MODES.map(item =>
                    h("span", {key: item.key, className: "slds-button slds-radio_button"},
                      h("input", {
                        type: "radio",
                        id: "pm-mode-" + item.key,
                        name: "pm-mode",
                        value: item.key,
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
              h("div", {className: "slds-col slds-size_1-of-1 slds-medium-size_1-of-2"}, this.renderObjectPicker(model))
            ),
            model.mode === "object"
              ? h("div", {className: "slds-m-top_small"},
                this.renderParentPicker(model),
                h("p", {className: "slds-text-body_small slds-m-top_x-small"},
                  h("a", {href: "#", onClick: this.onSwitchToUser}, "Switch to User mode"),
                  " to see effective permissions for a user on this object."
                )
              )
              : null,
            model.mode === "user" && model.parents.length
              ? h("p", {className: "slds-text-body_small slds-m-top_small"},
                "Assignments: " + model.parents.map(parent => parentKindLabel(parent.kind) + ": " + parent.label).join(" · ")
              )
              : null,
            h("div", {className: "slds-m-top_small"}, this.renderToolbar(model))
          )
        ),
        this.renderOlsTable(model),
        this.renderFlsTable(model)
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
