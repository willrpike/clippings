/* -*- mode: javascript; tab-width: 8; indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const DEBUG_TREE = false;
const DEBUG_WND_ACTIONS = false;
const ENABLE_PASTE_CLIPPING = false;
const NEW_CLIPPING_FROM_CLIPBOARD = "New Clipping From Clipboard";

let gOS;
let gClippingsDB;
let gClippings;
let gIsClippingsTreeEmpty;
let gIsReloading = false;
let gDialogs = {};
let gOpenerWndID;
let gIsMaximized;
let gSuppressAutoMinzWnd;
let gSyncFolderID;
let gSyncedItemsIDs = {};
let gIsBackupMode = false;
let gErrorPushSyncItems = false;
let gReorderedTreeNodeNextSibling = null;


// DOM utility
function sanitizeHTML(aHTMLStr)
{
  return DOMPurify.sanitize(aHTMLStr, { SAFE_FOR_JQUERY: true });
}


// Wrappers to database create/update/delete operations. These also call the
// Clippings listeners upon completion of the database operations.
let gClippingsSvc = {
  async createClipping(aClippingData)
  {
    let newClippingID = await gClippingsDB.clippings.add(aClippingData);
    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
    clippingsListeners.forEach(aListener => {
      aListener.newClippingCreated(newClippingID, aClippingData, aeConst.ORIGIN_CLIPPINGS_MGR);
    });

    return newClippingID;
  },

  async createFolder(aFolderData)
  {
    let newFolderID = await gClippingsDB.folders.add(aFolderData);
    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
    clippingsListeners.forEach(aListener => {
      aListener.newFolderCreated(newFolderID, aFolderData, aeConst.ORIGIN_CLIPPINGS_MGR);
    });

    return newFolderID;
  },

  async updateClipping(aClippingID, aChanges, aOldClipping)
  {
    if (! aOldClipping) {
      aOldClipping = await gClippingsDB.clippings.get(aClippingID);
    }
    let numUpd = await gClippingsDB.clippings.update(aClippingID, aChanges);

    let newClipping = {};
    let keys = Object.keys(aOldClipping);
    for (let key of keys) {
      if (key in aChanges) {
        newClipping[key] = aChanges[key];
      }
      else {
        newClipping[key] = aOldClipping[key];
      }
    }        

    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
    clippingsListeners.forEach(aListener => {
      aListener.clippingChanged(aClippingID, newClipping, aOldClipping);
    });

    return numUpd;
  },

  async updateFolder(aFolderID, aChanges, aOldFolder)
  {
    if (! aOldFolder) {
      aOldFolder = await gClippingsDB.folders.get(aFolderID);
    } 
    let numUpd = await gClippingsDB.folders.update(aFolderID, aChanges);

    let newFolder = {};
    let keys = Object.keys(aOldFolder);
    for (let key of keys) {
      if (key in aChanges) {
        newFolder[key] = aChanges[key];
      }
      else {
        newFolder[key] = aOldFolder[key];
      }
    }        

    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
    clippingsListeners.forEach(aListener => {
      aListener.folderChanged(aFolderID, newFolder, aOldFolder);
    });

    return numUpd;
  },

  async deleteClipping(aClippingID)
  {
    await gClippingsDB.clippings.delete(aClippingID);

    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
    clippingsListeners.forEach(aListener => {
      aListener.clippingDeleted(aClippingID);    
    });
  },

  async deleteFolder(aFolderID)
  {
    await gClippingsDB.folders.delete(aFolderID);

    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
    clippingsListeners.forEach(aListener => {
      aListener.folderDeleted(aFolderID);
    });
  }
};


// Clippings listener object
let gClippingsListener = {
  _isCopying:   false,

  origin: null,
  copiedItems: [],
  
  newClippingCreated: function (aID, aData, aOrigin, aDontSelect)
  {
    if (this._isCopying) {
      return;
    }
    
    if (gIsClippingsTreeEmpty) {
      unsetEmptyClippingsState();
    }

    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    let newNodeData = {
      key: aID + "C",
      title: sanitizeTreeNodeTitle(DEBUG_TREE ? `${aData.name} [key=${aID}C]` : aData.name)
    };

    let newNode = null;

    if (selectedNode) {
      if (aData.parentFolderID == aeConst.ROOT_FOLDER_ID) {
        newNode = tree.rootNode.addNode(newNodeData);
      }
      else {
        let parentNode = tree.getNodeByKey(aData.parentFolderID + "F");
        newNode = parentNode.addNode(newNodeData);
      }
    }
    else {
      // No clippings or folders.
      newNode = tree.rootNode.addNode(newNodeData);
    }

    if (aData.label) {
      newNode.addClass(`ae-clipping-label-${aData.label}`);
    }

    if (aDontSelect) {
      return;
    }

    let newClipping = {
      id: aData.id,
      name: aData.name,
      parentFolderID: aData.parentFolderID,
    };

    newNode.makeVisible().done(() => {     
      newNode.setActive();
      $("#clipping-name").val(newClipping.name);
      $("#clipping-text").val("");

      // Clipping created outside Clippings Manager. Add to undo stack.
      if (aOrigin == aeConst.ORIGIN_HOSTAPP) {
        gCmd.undoStack.push({
          action: gCmd.ACTION_CREATENEW,
          id: newClipping.id,
          itemType: gCmd.ITEMTYPE_CLIPPING,
          parentFldrID: newClipping.parentFolderID,
        });
      }
    });
  },

  newFolderCreated: function (aID, aData, aOrigin, aDontSelect)
  {
    if (this._isCopying) {
      return;
    }
    
    if (gIsClippingsTreeEmpty) {
      unsetEmptyClippingsState();
    }
    
    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    let newNodeData = {
      key: aID + "F",
      title: sanitizeTreeNodeTitle(DEBUG_TREE ? `${aData.name} [key=${aID}F]` : aData.name),
      folder: true,
      children: []
    };

    if (aID == gClippings.getSyncFolderID()) {
      newNodeData.extraClasses = "ae-synced-clippings-fldr";
    }

    let newNode = null;
    
    if (selectedNode) {
      if (aData.parentFolderID == aeConst.ROOT_FOLDER_ID) {
        newNode = tree.rootNode.addNode(newNodeData);
      }
      else {
        let parentNode = tree.getNodeByKey(aData.parentFolderID + "F");
        newNode = parentNode.addNode(newNodeData);
      }
    }
    else {
      // No clippings or folders.
      newNode = tree.rootNode.addNode(newNodeData);
    }

    if (aDontSelect) {
      return;
    }

    let newFolder = {
      id: aData.id,
      name: aData.name,
      parentFolderID: aData.parentFolderID,
    };

    newNode.makeVisible().done(() => {
      newNode.setActive();
      $("#clipping-name").val(newFolder.name);
      $("#clipping-text").val("");

      // Folder created outside Clippings Manager. Add to undo stack.
      if (aOrigin == aeConst.ORIGIN_HOSTAPP) {
        gCmd.undoStack.push({
          action: gCmd.ACTION_CREATENEWFOLDER,
          id: newFolder.id,
          itemType: gCmd.ITEMTYPE_FOLDER,
          parentFldrID: newFolder.parentFolderID,
        });
      }
    });
  },

  clippingChanged: function (aID, aData, aOldData)
  {
    let tree = getClippingsTree();

    if (aData.parentFolderID != aOldData.parentFolderID) {
      let oldParentFldrID = aOldData.parentFolderID;
      let newParentFldrID = aData.parentFolderID;

      if (this._isFlaggedForDelete(aData)) {
        this._removeClippingsTreeNode(aID + "C");
        gCmd.updateDisplayOrder(oldParentFldrID, null, null, true);
      }
      else {
        log("Clippings/wx::clippingsMgr.js::gClippingsListener.clippingChanged(): Handling clipping move");
        let changedNode = tree.getNodeByKey(aID + "C");
        if (changedNode) {
          let targParentNode;
          if (aData.parentFolderID == aeConst.ROOT_FOLDER_ID) {
            targParentNode = tree.rootNode;
          }
          else {
            targParentNode = tree.getNodeByKey(aData.parentFolderID + "F");
          }
          
          changedNode.moveTo(targParentNode, "child");

          log("Clippings/wx::clippingsMgr.js: gCmd.clippingChanged(): Updating display order of changed clipping");
          gCmd.updateDisplayOrder(oldParentFldrID, null, null, true).then(() => {
            gCmd.updateDisplayOrder(newParentFldrID, null, null, true);
          });
        }
        else {
          // Undoing delete.
          let newNodeData = {
            key: aID + "C",
            title: sanitizeTreeNodeTitle(DEBUG_TREE ? `${aData.name} [key=${aID}C]` : aData.name)
          };

          if (aData.parentFolderID == aeConst.ROOT_FOLDER_ID) {
            changedNode = tree.rootNode.addNode(newNodeData);
          }
          else {
            let parentNode = tree.getNodeByKey(aData.parentFolderID + "F");
            changedNode = parentNode.addNode(newNodeData);
          }

          if (aData.label) {
            changedNode.addClass(`ae-clipping-label-${aData.label}`);
          }

          log(`Clippings/wx::clippingsMgr.js: gCmd.clippingChanged(): Updating display order of items under folder (ID = ${newParentFldrID}) after undoing clipping deletion`);
          gCmd.updateDisplayOrder(newParentFldrID, null, null, true);
        }

        changedNode.makeVisible().then(() => { changedNode.setActive() });
      }
    }
    else if (aData.name != aOldData.name) {
      let changedNode = tree.getNodeByKey(aID + "C");
      changedNode.setTitle(sanitizeTreeNodeTitle(aData.name));
    }
  },

  folderChanged: function (aID, aData, aOldData)
  {
    let tree = getClippingsTree();

    if (aData.parentFolderID != aOldData.parentFolderID) {
      let oldParentFldrID = aOldData.parentFolderID;
      let newParentFldrID = aData.parentFolderID;

      if (this._isFlaggedForDelete(aData)) {
        this._removeClippingsTreeNode(aID + "F");
        gCmd.updateDisplayOrder(oldParentFldrID, null, null, true);
      }
      else {
        log("Clippings/wx::clippingsMgr.js::gClippingsListener.folderChanged: Handling folder move");
        let changedNode = tree.getNodeByKey(aID + "F");
        if (changedNode) {
          let targParentNode;
          if (aData.parentFolderID == aeConst.ROOT_FOLDER_ID) {
            targParentNode = tree.rootNode;
          }
          else {
            targParentNode = tree.getNodeByKey(aData.parentFolderID + "F");
          }
          
          changedNode.moveTo(targParentNode, "child");

          log("Clippings/wx::clippingsMgr.js: gCmd.folderChanged(): Updating display order of changed folder");
          let newParentFldrID = aData.parentFolderID;
          gCmd.updateDisplayOrder(oldParentFldrID, null, null, true).then(() => {
            gCmd.updateDisplayOrder(newParentFldrID, null, null, true);
          });
        }
        else {
          // Undoing delete.
          let newNodeData = {
            key: aID + "F",
            title: sanitizeTreeNodeTitle(DEBUG_TREE ? `${aData.name} [key=${aID}C]` : aData.name),
            folder: true,
            children: []
          };

          if (aData.parentFolderID == aeConst.ROOT_FOLDER_ID) {
            changedNode = tree.rootNode.addNode(newNodeData);
          }
          else {
            let parentNode = tree.getNodeByKey(aData.parentFolderID + "F");
            changedNode = parentNode.addNode(newNodeData);
          }

          log("Clippings/wx::clippingsMgr.js: gCmd.folderChanged(): Updating display order after undoing folder deletion");
          gCmd.updateDisplayOrder(newParentFldrID, null, null, true).then(() => {
            this._buildChildNodes(changedNode);
          });
        }
        changedNode.makeVisible().then(() => { changedNode.setActive() });
      }
    }
    else if (aData.name != aOldData.name) {
      let changedNode = tree.getNodeByKey(aID + "F");
      changedNode.setTitle(sanitizeTreeNodeTitle(aData.name));
    }
  },

  clippingDeleted: function (aID, aOldData) {},
  folderDeleted: function (aID, aOldData) {},
  dndMoveStarted: function () {},
  dndMoveFinished: function () {},
  
  copyStarted: function ()
  {
    this._isCopying = true;
  },

  copyFinished: function (aItemCopyID)
  {
    info("Clippings/wx::clippingsMgr.js: gClippingsListener.copyFinished()");
       
    this._isCopying = false;
    
    for (let i = 0; i < this.copiedItems.length; i++) {
      let item = this.copiedItems[i];
      if (item.itemType == gCmd.ITEMTYPE_FOLDER) {
        let suppressFldrSelect = true;
        if (item.id == aItemCopyID) {
          suppressFldrSelect = false;
        }
        this.newFolderCreated(item.id, item, aeConst.ORIGIN_CLIPPINGS_MGR, suppressFldrSelect);
      }
    }

    for (let i = 0; i < this.copiedItems.length; i++) {
      let item = this.copiedItems[i];
      if (item.itemType == gCmd.ITEMTYPE_CLIPPING) {
        this.newClippingCreated(item.id, item, aeConst.ORIGIN_CLIPPINGS_MGR, true);
      }
    }

    this.copiedItems = [];
  },

  importStarted: function () {},
  importFinished: function (aIsSuccess) {},

  // Helper methods
  _buildChildNodes: function (aFolderNode)
  {
    let id = parseInt(aFolderNode.key);
    
    gClippingsDB.transaction("rw", gClippingsDB.clippings, gClippingsDB.folders, () => {
      gClippingsDB.folders.where("parentFolderID").equals(id).each((aItem, aCursor) => {
        let newFldrNode = aFolderNode.addChildren({
          key: aItem.id + "F",
          title: sanitizeTreeNodeTitle(DEBUG_TREE ? `${aItem.name} [key=${aID}C]` : aItem.name),
          folder: true,
          children: []
        });
        this._buildChildNodes(newFldrNode);

      }).then(() => {
        return gClippingsDB.clippings.where("parentFolderID").equals(id).each((aItem, aCursor) => {
          aFolderNode.addChildren({
            key: aItem.id + "C",
            title: sanitizeTreeNodeTitle(DEBUG_TREE ? `${aItem.name} [key=${aID}C]` : aItem.name)
          });
        });

      }).then(() => {
        log(`Clippings/wx::clippingsMgr.js::gClippingsListener._buildChildNodes(): Updating display order for child folder '${aFolderNode.title}' (key = ${aFolderNode.key})`);
        gCmd.updateDisplayOrder(id, null, null, true);
      });
    }).catch(aErr => {
      console.error("Clippings/wx::clippingsMgr.js::gClippingsListener._buildChildNodes(): " + aErr);
    });
  },
  
  _removeClippingsTreeNode: function (aIDWithSuffix)
  {
    let tree = getClippingsTree();
    let targetNode = tree.getNodeByKey(aIDWithSuffix);
    let deletedNodeIdx = targetNode.getIndex();
    let prevSibNode = targetNode.getPrevSibling();
    let nextSibNode = targetNode.getNextSibling();
    let parentNode = targetNode.getParent();
    
    targetNode.remove();

    if (tree.count() == 0) {
      tree.options.icon = false;
      let emptyMsgNode = setEmptyClippingsState();
      tree.rootNode.addNode(emptyMsgNode);
      setStatusBarMsg(browser.i18n.getMessage("clipMgrStatusBar", "0"));
    }
    else {
      // Select the node that used to be occupied by the delete node. If the
      // deleted node was the last node of its parent folder, then select the
      // last child of the parent.
      if (nextSibNode) {
        nextSibNode.setActive();
      }
      else if (prevSibNode) {
        prevSibNode.setActive();
      }
      else {
        if (parentNode.isRootNode()) {
          let parentNodes = parentNode.getChildren();
          if (deletedNodeIdx < parentNodes.length) {
            parentNodes[deletedNodeIdx].setActive();
          }
          else {
            parentNodes[parentNodes.length].setActive();
          }
        }
        else {
          parentNode.setActive();
        }
      }
    }
  },

  _isFlaggedForDelete: function (aItem)
  {
    return (aItem.parentFolderID == aeConst.DELETED_ITEMS_FLDR_ID);
  }
};

let gSyncClippingsListener = {
  onActivate(aSyncFolderID)
  {
    log("Clippings/wx::clippingsMgr.js::gSyncClippingsListener.onActivate()");
    gDialogs.reloadSyncFolder.showModal();
  },
  
  onDeactivate(aOldSyncFolderID)
  {
    log(`Clippings/wx::clippingsMgr.js::gSyncClippingsListener.onDeactivate(): ID of old sync folder: ${aOldSyncFolderID}`);
    gSyncedItemsIDs = {};

    gReloadSyncFldrBtn.hide();
    
    let clippingsTree = getClippingsTree();
    let syncFldrTreeNode = clippingsTree.getNodeByKey(aOldSyncFolderID + "F");
    syncFldrTreeNode.removeClass("ae-synced-clippings-fldr");
  },

  onAfterDeactivate(aRemoveSyncFolder, aOldSyncFolderID)
  {
    log(`Clippings/wx::clippingsMgr.js: gSyncClippingsListener.onAfterDeactivate(): Remove Synced Clippings folder = ${aRemoveSyncFolder}; old sync folder ID = ${aOldSyncFolderID}`)

    if (aRemoveSyncFolder) {
      let clippingsTree = getClippingsTree();

      let syncFldrTreeNode = clippingsTree.getNodeByKey(aOldSyncFolderID + "F");
      syncFldrTreeNode.remove();
      setStatusBarMsg();
      
      // TO DO: If there are no longer any clippings and folders, then show the
      // empty clippings UI.
    }
  },

  onReloadStart() {},
  onReloadFinish() {},
};


// Search box
let gSearchBox = {
  _isInitialized: false,
  _isActive: false,
  _numMatches: null,
  _clippingsTree: null,

  init: function ()
  {
    if (this._isInitialized) {
      return;
    }
    
    $("#search-box").prop("placeholder", browser.i18n.getMessage("clipMgrSrchBarHint"));
    $("#search-box").focus(aEvent => {
      gSearchBox.activate();
    });

    $("#search-box").keyup(aEvent => {
      this.updateSearch();
      $("#clear-search").css({
        visibility: (aEvent.target.value ? "visible" : "hidden")
      });
    });

    $("#clear-search").click(aEvent => { this.reset() });

    this._isInitialized = true;
  },

  show: function ()
  {
    $("#search-clippings-and-folders").show();
  },

  hide: function ()
  {
    $("#search-clippings-and-folders").hide();
  },
  
  isVisible: function ()
  {
    return ($("#search-clippings-and-folders").css("display") != "none");
  },
  
  isActivated: function ()
  {
    return this._isActive;
  },

  updateSearch: function ()
  {
    let tree = getClippingsTree();
    let numMatches = tree.filterNodes($("#search-box").val());
    if (numMatches === undefined) {
      // User cleared search box by deleting all search text
      setStatusBarMsg();
      this._isActive = false;
    }
    else {
      setStatusBarMsg(browser.i18n.getMessage("numMatches", numMatches));
    }

    this._numMatches = numMatches;
  },

  getCountMatches: function ()
  {
    return this._numMatches;
  },

  activate: function ()
  {
    this._isActive = true;
  },
  
  reset: function ()
  {
    getClippingsTree().clearFilter();
    $("#search-box").val("").focus();
    $("#clear-search").css({ visibility: "hidden" });
    setStatusBarMsg();
    this._isActive = false;
  }
};

// Source URL editing
let gSrcURLBar = {
  init: function ()
  {
    $("#src-url-edit-mode").hide();
    $("#edit-url-btn").click(aEvent => { this.edit() });
    $("#edit-src-url-ok").attr("title", browser.i18n.getMessage("btnOK")).click(aEvent => { this.acceptEdit() });
    $("#edit-src-url-cancel").attr("title", browser.i18n.getMessage("btnCancel")).click(aEvent => { this.cancelEdit() });
  },

  show: function ()
  {
    $("#source-url-bar").show();
  },

  hide: function ()
  {
    $("#source-url-bar").hide();
  },

  isVisible: function ()
  {
    return ($("#source-url-bar:visible").length > 0);
  },

  keypress: function (aEvent)
  {

  },

  edit: function ()
  {
    $("#src-url-normal-mode").hide();
    $("#src-url-edit-mode").show();
    $("#clipping-src-url-edit").val($("#clipping-src-url > a").text()).select().focus();
  },

  isEditing: function ()
  {
    return ($("#src-url-edit-mode:visible").length > 0);
  },

  acceptEdit: function ()
  {
    let updatedURL = $("#clipping-src-url-edit").val();

    if (updatedURL != "" && updatedURL.search(/^http:\/\//) == -1
        && updatedURL.search(/^https:\/\//) == -1) {

      if (updatedURL.search(/^www/) != -1) {
        updatedURL = "http://" + updatedURL;
        $("#clipping-src-url-edit").val(updatedURL);
      }
      else {
        $("#clipping-src-url-edit").select().focus();
        return;
      }
    }
    
    let tree = getClippingsTree();
    let clippingID = parseInt(tree.activeNode.key);
    
    gClippingsSvc.updateClipping(clippingID, {
      sourceURL: updatedURL
    }).then(aNumUpdated => {
      if ($("#clipping-src-url > a").length == 0) {
        $("#clipping-src-url").html(sanitizeHTML(`<a href="${updatedURL}">${updatedURL}</a>`));
      }
      else {
        if (updatedURL) {
          $("#clipping-src-url > a").text(updatedURL);
        }
        else {
          $("#clipping-src-url").text(browser.i18n.getMessage("none"));
        }
      }
      this._dismissSrcURLEditMode();

      if (updatedURL && gSyncedItemsIDs[clippingID + "C"]) {
        gClippings.pushSyncFolderUpdates().catch(handlePushSyncItemsError);
      }
    });
  },

  cancelEdit: function ()
  {
    this._dismissSrcURLEditMode();
  },

  // Helper
  _dismissSrcURLEditMode: function ()
  {
    $("#src-url-normal-mode").show();
    $("#src-url-edit-mode").hide();
    $("#clipping-src-url-edit").val("");
  }
};


// Shortcut key editing
let gShortcutKey = {
  _oldKey:   "",
  _oldIndex: -1,

  init: function ()
  {
    $("#clipping-key").change(aEvent => {
      this.update();
    }).mousedown(aEvent => {
      this.setPrevShortcutKey();
    });

    $("#show-shortcut-list").attr("title", browser.i18n.getMessage("clipMgrShortcutHelpHint"));
  },

  getPrevSelectedIndex: function ()
  {
    return this._oldIndex;
  },
  
  setPrevShortcutKey: function ()
  {
    let selectedNode = getClippingsTree().getActiveNode();
    if (! selectedNode) {
      return;
    }

    let clippingID = parseInt(selectedNode.key);
    this._oldIndex = $("#clipping-key")[0].selectedIndex;

    gClippingsDB.clippings.get(clippingID).then(aClipping => {
      this._oldKey = aClipping.shortcutKey;
    });
  },

  update: function ()
  {
    let shortcutKey = "";
    let shortcutKeyMenu = $("#clipping-key")[0];

    if (shortcutKeyMenu.selectedIndex == 0) {
      if (! this._oldKey) {
	// Skip shortcut key update if none was ever defined.
	return;
      }
    }
    else {
      shortcutKey = shortcutKeyMenu.options[shortcutKeyMenu.selectedIndex].text;
    }

    if (shortcutKey == this._oldKey) {
      return;
    }

    // Check if the shortcut key is already assigned.
    let assignedKeysLookup = {};
    gClippingsDB.clippings.where("shortcutKey").notEqual("").each((aItem, aCursor) => {
      assignedKeysLookup[aItem.shortcutKey] = 1;
    }).then(() => {
      if (assignedKeysLookup[shortcutKey]) {
        gDialogs.shctKeyConflict.showModal();
        return;
      }

      let selectedNode = getClippingsTree().getActiveNode();
      if (! selectedNode) {
        throw new Error("Can't set shortcut key if there is no clipping selected.");
      }

      let clippingID = parseInt(selectedNode.key);
      gClippingsSvc.updateClipping(clippingID, { shortcutKey }).then(aNumUpd => {
        if (gSyncedItemsIDs[clippingID + "C"]) {
          gClippings.pushSyncFolderUpdates().catch(handlePushSyncItemsError);
        }
      });
    }).catch (aErr => {
      console.error(aErr);
    });
  }
};

// Clipping label picker in the options bar
let gClippingLabelPicker = {
  _labelPicker: null,
  
  init(aLabelPickerStor)
  {
    this._labelPicker = $(aLabelPickerStor);

    this._labelPicker.on("change", aEvent => {
      if (isFolderSelected()) {
        return;
      }

      let selectedNode = getClippingsTree().activeNode;
      let id = parseInt(selectedNode.key);
      let label = this.selectedLabel;

      gCmd.setLabelIntrl(id, label, gCmd.UNDO_STACK);
    });
  },

  get selectedLabel()
  {
    return this._labelPicker.val();
  },

  set selectedLabel(aLabel)
  {
    let bgColor = aLabel;
    let fgColor = "white";

    if (! aLabel) {
      bgColor = "var(--color-btn-bkgd)";
      fgColor = "var(--color-default-text)";
    }
    else if (aLabel == "yellow") {
      fgColor = "initial";
    }

    this._labelPicker.css({
      backgroundColor: bgColor,
      color: fgColor
    });
    this._labelPicker.val(aLabel);
  }
};

// Reload button for the Synced Clippings folder.
let gReloadSyncFldrBtn = {
  show()
  {
    let syncFldrID = gClippings.getSyncFolderID();
    if (syncFldrID === null) {
      return;
    }

    let syncFldrSpanElt = this._getSyncFldrSpan()[0];
    let reloadBtn = document.createElement("span");
    reloadBtn.id = "reload-sync-fldr-btn";
    reloadBtn.title = browser.i18n.getMessage("btnReload");
    reloadBtn.addEventListener("click", aEvent => { gCmd.reloadSyncFolder() });
    
    syncFldrSpanElt.appendChild(reloadBtn);
  },

  hide()
  {
    let syncFldrSpan = this._getSyncFldrSpan();
    if (! syncFldrSpan) {
      console.error("Clippings/wx::clippingsMgr.js: gReloadSyncFldrBtn.hide(): Failed to retrieve the Fancytree <span> element for the Synced Clippings folder!");
      return;
    }

    let syncFldrSpanElt = syncFldrSpan[0];
    let reloadBtnElt = document.getElementById("reload-sync-fldr-btn");
    syncFldrSpanElt.removeChild(reloadBtnElt);
  },

  _getSyncFldrSpan() {
    return $("#clippings-tree > ul.ui-fancytree > li > span.ae-synced-clippings-fldr");
  },
};


// Clippings Manager commands
let gCmd = {
  // IDs of undoStack actions
  ACTION_EDITNAME: 1,
  ACTION_EDITCONTENT: 2,
  ACTION_DELETECLIPPING: 3,
  ACTION_CREATENEW: 4,
  ACTION_CHANGEPOSITION: 5,
  ACTION_CREATENEWFOLDER: 6,
  ACTION_DELETEFOLDER: 7,
  ACTION_MOVETOFOLDER: 8,
  ACTION_COPYTOFOLDER: 9,
  ACTION_DELETEEMPTYFOLDER: 10,
  ACTION_SETSHORTCUTKEY: 11,
  ACTION_SETLABEL: 12,
  ACTION_SET_SRC_URL: 13,
  ACTION_REMOVE_ALL_SRC_URLS: 14,
  ACTION_BACKUP: 15,
  ACTION_RESTORE_BACKUP: 16,
  ACTION_IMPORT: 17,
  ACTION_EXPORT: 18,
  ACTION_RELOAD_SYNC_FLDR: 19,

  // flags for aDestUndoStack parameter of functions for reversible actions
  UNDO_STACK: 1,
  REDO_STACK: 2,

  // Differentiate between clippings and folders, since they can have the same
  // ID in the database.
  ITEMTYPE_CLIPPING: 1,
  ITEMTYPE_FOLDER: 2,

  // Keep track of the most recent action.
  // This was previously required for the now-eliminated `onBatchChanges`
  // database event handler.
  _recentAction: null,

  undoStack: {
    length: 0,
    _stack: [],

    push(aState) {
      this._stack.push(aState);
      this.length++;
    },

    pop() {
      var rv = this._stack.pop();
      this.length--;
      return rv;
    },

    getLastItem() {
      let rv = null;
      
      if (this.length > 0) {
	rv = this._stack[this.length - 1];
      }
      return rv;
    }
  },

  // Redo - only 1 undo action is reversible
  redoStack: {
    length: 0,
    _lastUndo: null,

    push(aState)
    {
      this._lastUndo = aState;
      this.length = (this.length == 0 ? 1 : 1);
    },

    pop()
    {
      var rv = {};
      for (let ppty in this._lastUndo) {
        rv[ppty] = this._lastUndo[ppty];
      }
      this._lastUndo = null;
      this.length = 0;
      return rv;
    }
  },
  
  get recentAction()
  {
    return this._recentAction;
  },

  set recentAction(aActionID)
  {
    return (this._recentAction = aActionID);
  },

  getRecentActionInfo()
  {
    let rv = null;
    let recentAction = this.undoStack.getLastItem();

    if (recentAction) {
      rv = recentAction;
    }
    
    return rv;
  },
  
  newClipping: function (aDestUndoStack, aIsFromClipboard)
  {
    if (gIsClippingsTreeEmpty) {
      unsetEmptyClippingsState();
    }
    
    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    let parentFolderID = aeConst.ROOT_FOLDER_ID;
    let displayOrder = 0;
    
    if (selectedNode) {
      parentFolderID = this._getParentFldrIDOfTreeNode(selectedNode);
      let parentFldrChildNodes = selectedNode.getParent().getChildren();
      if (parentFldrChildNodes === undefined) {
        warn("Clippings/wx::clippingsMgr.js: gCmd.newClipping(): Can't get child nodes of the parent node, because Fancytree lazy loading is in effect!");
      }
      else {
        displayOrder = parentFldrChildNodes.length;
      }
    }

    let name = browser.i18n.getMessage("newClipping");
    if (aIsFromClipboard) {
      name = NEW_CLIPPING_FROM_CLIPBOARD;
    }

    this.recentAction = this.ACTION_CREATENEW;

    let newClipping = {
      name,
      content: "",
      shortcutKey: "",
      parentFolderID: parentFolderID,
      label: "",
      sourceURL: "",
      displayOrder,      
    };
      
    gClippingsSvc.createClipping(newClipping).then(aNewClippingID => {
      if (aDestUndoStack == this.UNDO_STACK) {
        this.undoStack.push({
          action: this.ACTION_CREATENEW,
          id: aNewClippingID,
          itemType: this.ITEMTYPE_CLIPPING,
          parentFldrID: parentFolderID,
        });
      }

      if (gSyncedItemsIDs[parentFolderID + "F"]) {
        gSyncedItemsIDs[aNewClippingID + "C"] = 1;
        gClippings.pushSyncFolderUpdates().catch(handlePushSyncItemsError);
      }
    });
  },

  newClippingWithContent: function (aParentFolderID, aName, aContent, aDestUndoStack)
  {
    if (gIsClippingsTreeEmpty) {
      unsetEmptyClippingsState();
    }
    
    let tree = getClippingsTree();
    let parentFldrID = aParentFolderID;

    this.recentAction = this.ACTION_CREATENEW;

    let newClipping = {
      name: aName,
      content: aContent,
      shortcutKey: "",
      parentFolderID: aParentFolderID,
      label: "",
      sourceURL: "",
      displayOrder: 999999,      
    };

    gClippingsSvc.createClipping(newClipping).then(aNewClippingID => {
      if (aDestUndoStack == this.UNDO_STACK) {
        this.undoStack.push({
          action: this.ACTION_CREATENEW,
          id: aNewClippingID,
          itemType: this.ITEMTYPE_CLIPPING
        });
      }

      if (gSyncedItemsIDs[parentFldrID + "F"]) {
        gSyncedItemsIDs[aNewClippingID + "C"] = 1;
        gClippings.pushSyncFolderUpdates().catch(handlePushSyncItemsError);
      }
    });
  },

  newFolder: function (aDestUndoStack)
  {
    if (gIsClippingsTreeEmpty) {
      unsetEmptyClippingsState();
    }

    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    let parentFolderID = aeConst.ROOT_FOLDER_ID;
    let displayOrder = 0;
    
    if (selectedNode) {
      parentFolderID = this._getParentFldrIDOfTreeNode(selectedNode);
      let parentFldrChildNodes = selectedNode.getParent().getChildren();
      if (parentFldrChildNodes === undefined) {
        warn("Clippings/wx::clippingsMgr.js: gCmd.newFolder(): Can't get child nodes of the parent node, because Fancytree lazy loading is in effect!");
      }
      else {
        displayOrder = parentFldrChildNodes.length;
      }
    }

    this.recentAction = this.ACTION_CREATENEWFOLDER;

    let newFolder = {
      name: browser.i18n.getMessage("newFolder"),
      parentFolderID,
      displayOrder,
    };

    gClippingsSvc.createFolder(newFolder).then(aNewFolderID => {
      if (aDestUndoStack == this.UNDO_STACK) {
        this.undoStack.push({
          action: this.ACTION_CREATENEWFOLDER,
          id: aNewFolderID,
          itemType: this.ITEMTYPE_FOLDER,
          parentFldrID: parentFolderID,
        });
      }

      if (gSyncedItemsIDs[parentFolderID + "F"]) {
        gSyncedItemsIDs[aNewFolderID + "F"] = 1;
        gClippings.pushSyncFolderUpdates().catch(handlePushSyncItemsError);
      }
    });
  },

  moveClippingOrFolder: function ()
  {
    if (gIsClippingsTreeEmpty) {
      return;
    }

    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    if (selectedNode && selectedNode.isFolder()) {
      let folderID = parseInt(selectedNode.key);
      if (folderID == gClippings.getSyncFolderID()) {
        window.setTimeout(() => {gDialogs.moveSyncFldr.showModal()});
        return;
      }
    }

    gDialogs.moveTo.showModal();
  },
  
  deleteClippingOrFolder: function (aDestUndoStack)
  {
    if (gIsClippingsTreeEmpty) {
      return;
    }

    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    if (! selectedNode) {
      return;
    }

    let id = parseInt(selectedNode.key);
    let parentFolderID = this._getParentFldrIDOfTreeNode(selectedNode);
    
    if (selectedNode.isFolder()) {
      if (id == gClippings.getSyncFolderID()) {
        window.setTimeout(() => {gDialogs.deleteSyncFldr.showModal()}, 100);
        return;
      }
      
      this.recentAction = this.ACTION_DELETEFOLDER;

      gClippingsSvc.updateFolder(id, { parentFolderID: aeConst.DELETED_ITEMS_FLDR_ID }).then(aNumUpd => {
        if (aDestUndoStack == this.UNDO_STACK) {
          this.undoStack.push({
            action: this.ACTION_DELETEFOLDER,
            itemType: this.ITEMTYPE_FOLDER,
            id,
            parentFolderID
          });
        }

        if (gSyncedItemsIDs[parentFolderID + "F"]) {
          gClippings.pushSyncFolderUpdates().then(() => {
            delete gSyncedItemsIDs[id + "F"];
          }).catch(handlePushSyncItemsError);
        }
      });
    }
    else {
      this.recentAction = this.ACTION_DELETECLIPPING;

      gClippingsSvc.updateClipping(id, {
        parentFolderID: aeConst.DELETED_ITEMS_FLDR_ID,
        shortcutKey: ""
      }).then(aNumUpd => {
        if (aDestUndoStack == this.UNDO_STACK) {
          this.undoStack.push({
            action: this.ACTION_DELETECLIPPING,
            itemType: this.ITEMTYPE_CLIPPING,
            id,
            parentFolderID
          });
        }

        if (gSyncedItemsIDs[parentFolderID + "F"]) {
          gClippings.pushSyncFolderUpdates().then(() => {
            delete gSyncedItemsIDs[id + "C"];
          }).catch(handlePushSyncItemsError);
        }
      });
    }
  },

  // Internal commands are NOT meant to be invoked directly from the UI.
  moveClippingIntrl: function (aClippingID, aNewParentFldrID, aDestUndoStack)
  {
    if (gIsClippingsTreeEmpty) {
      unsetEmptyClippingsState();
    }

    let oldParentFldrID;
    this.recentAction = this.ACTION_MOVETOFOLDER;
          
    gClippingsDB.clippings.get(aClippingID).then(aClipping => {
      oldParentFldrID = aClipping.parentFolderID;
      return gClippingsSvc.updateClipping(aClippingID, { parentFolderID: aNewParentFldrID }, aClipping);
    }).then(aNumUpd => {
      let state = {
        action: this.ACTION_MOVETOFOLDER,
        itemType: this.ITEMTYPE_CLIPPING,
        id: aClippingID,
        oldParentFldrID,
        newParentFldrID: aNewParentFldrID
      };
      
      if (aDestUndoStack == this.UNDO_STACK) {
        this.undoStack.push(state);
      }
      else if (aDestUndoStack == this.REDO_STACK) {
        this.redoStack.push(state);
      }

      if (gSyncedItemsIDs[aNewParentFldrID + "F"] || gSyncedItemsIDs[oldParentFldrID + "F"]) {
        gClippings.pushSyncFolderUpdates().then(() => {
          // Remove clipping from synced items lookup array if it was moved out
          // of a synced folder.
          if (gSyncedItemsIDs[aClippingID + "C"] && !gSyncedItemsIDs[aNewParentFldrID + "F"]) {
            delete gSyncedItemsIDs[aClippingID + "C"];
          }

          // Add clipping to synced items lookup array if moved to a synced
          // folder.
          if (gSyncedItemsIDs[aNewParentFldrID + "F"]) {
            gSyncedItemsIDs[aClippingID + "C"] = 1;
          }
        }).catch(handlePushSyncItemsError);
      }
    }).catch(aErr => { console.error(aErr) });
  },

  copyClippingIntrl: function (aClippingID, aDestFldrID, aDestUndoStack)
  {
    this.recentAction = this.ACTION_COPYTOFOLDER;

    let clippingCpy = {};
   
    gClippingsDB.clippings.get(aClippingID).then(aClipping => {
      let tree = getClippingsTree();
      let parentFldrNode;
      if (aDestFldrID == aeConst.ROOT_FOLDER_ID) {
        parentFldrNode = tree.rootNode
      }
      else {
        parentFldrNode = tree.getNodeByKey(aDestFldrID + "F");
      }
      let parentFldrChildNodes = parentFldrNode.getChildren();
      let displayOrder = parentFldrChildNodes ? parentFldrChildNodes.length : 0;

      clippingCpy = {
        name: aClipping.name,
        content: aClipping.content,
        shortcutKey: "",
        parentFolderID: aDestFldrID,
        label: aClipping.label,
        sourceURL: aClipping.sourceURL,
        displayOrder
      };

      return gClippingsSvc.createClipping(clippingCpy);

    }).then(aNewClippingID => {
      if (aDestUndoStack == this.UNDO_STACK) {
        this.undoStack.push({
          action: this.ACTION_COPYTOFOLDER,
          id: aNewClippingID,
          itemType: this.ITEMTYPE_CLIPPING,
          destFldrID: aDestFldrID,
        });
      }

      if (gSyncedItemsIDs[aDestFldrID + "F"]) {
        gClippings.pushSyncFolderUpdates().then(() => {
          gSyncedItemsIDs[aClippingID + "C"] = 1;
        }).catch(handlePushSyncItemsError);
      }
    }).catch(aErr => {
      console.error(aErr);
    });
  },
  
  moveFolderIntrl: function (aFolderID, aNewParentFldrID, aDestUndoStack)
  {
    if (gIsClippingsTreeEmpty) {
      unsetEmptyClippingsState();
    }

    let oldParentFldrID;
    this.recentAction = this.ACTION_MOVETOFOLDER;
    
    gClippingsDB.folders.get(aFolderID).then(aFolder => {
      oldParentFldrID = aFolder.parentFolderID;
      let folderCpy = {
        parentFolderID: aNewParentFldrID,
      };
      return gClippingsSvc.updateFolder(aFolderID, folderCpy, aFolder);

    }).then(aNumUpd => {
      if (aDestUndoStack == this.UNDO_STACK) {
        this.undoStack.push({
          action: this.ACTION_MOVETOFOLDER,
          itemType: this.ITEMTYPE_FOLDER,
          id: aFolderID,
          oldParentFldrID,
          newParentFldrID: aNewParentFldrID
        });
      }

      if (gSyncedItemsIDs[aNewParentFldrID + "F"] || gSyncedItemsIDs[oldParentFldrID + "F"]) {
        gClippings.pushSyncFolderUpdates().then(() => {
          if (gSyncedItemsIDs[aFolderID + "F"] && !gSyncedItemsIDs[aNewParentFldrID + "F"]) {
            delete gSyncedItemsIDs[aFolderID + "F"];
          }
        }).catch(handlePushSyncItemsError);

        if (gSyncedItemsIDs[aNewParentFldrID + "F"]) {
          gSyncedItemsIDs[aFolderID + "F"] = 1;
        }
      }
    }).catch(aErr => { console.error(aErr) });
  },

  copyFolderIntrl: function (aFolderID, aDestFldrID, aDestUndoStack)
  {
    let newFldrID = null;
    
    this.recentAction = this.ACTION_COPYTOFOLDER;

    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
    clippingsListeners.forEach(aListener => {
      aListener.copyStarted();
    });

    let folderCpy = {};
      
    gClippingsDB.folders.get(aFolderID).then(aFolder => {
      let tree = getClippingsTree();
      let parentFldrNode;
      if (aDestFldrID == aeConst.ROOT_FOLDER_ID) {
        parentFldrNode = tree.rootNode
      }
      else {
        parentFldrNode = tree.getNodeByKey(aDestFldrID + "F");
      }
      let parentFldrChildNodes = parentFldrNode.getChildren();
      let displayOrder = parentFldrChildNodes ? parentFldrChildNodes.length : 0;

      folderCpy = {
        name: aFolder.name,
        parentFolderID: aDestFldrID,
        displayOrder,
      };
      return gClippingsSvc.createFolder(folderCpy);
      
    }).then(aNewFolderID => {
      newFldrID = aNewFolderID;

      gClippingsListener.copiedItems.push({
        id: newFldrID,
        itemType: this.ITEMTYPE_FOLDER,
        name: folderCpy.name,
        parentFolderID: folderCpy.parentFolderID,
      });

      return this._copyFolderHelper(aFolderID, aNewFolderID);
      
    }).then(() => {
      if (aDestUndoStack == this.UNDO_STACK) {
        this.undoStack.push({
          action: this.ACTION_COPYTOFOLDER,
          id: newFldrID,
          itemType: this.ITEMTYPE_FOLDER,
          destFldrID: aDestFldrID,
        });
      }

      if (gSyncedItemsIDs[aDestFldrID + "F"]) {
        gClippings.pushSyncFolderUpdates().then(() => {
          gSyncedItemsIDs[aFolderID + "F"] = 1;
        }).catch(handlePushSyncItemsError);
      }

      clippingsListeners.forEach(aListener => {
        aListener.copyFinished(newFldrID);
      });
    }).catch(aErr => {
      console.error("Clippings/wx::clippingsMgr.js: gCmd.copyFolderIntrl(): " + aErr);
      window.alert("Error copying folder: " + aErr);
    });
  },
  
  editFolderNameIntrl: function (aFolderID, aName, aDestUndoStack)
  {
    let that = this;
    
    return new Promise((aFnResolve, aFnReject) => {
      let oldName = "";
      
      gClippingsDB.folders.get(aFolderID).then(aFolder => {
        oldName = aFolder.name;

        if (aName == oldName) {
          return 0;
        }

	that.recentAction = that.ACTION_EDITNAME;
        return gClippingsSvc.updateFolder(aFolderID, { name: aName }, aFolder);

      }).then(aNumUpd => {
        if (aNumUpd && aDestUndoStack == that.UNDO_STACK) {
          that.undoStack.push({
            action: that.ACTION_EDITNAME,
            id: aFolderID,
            name: aName,
            oldName,
            itemType: that.ITEMTYPE_FOLDER
          });
        }

        if (gSyncedItemsIDs[aFolderID + "F"]) {
          gClippings.pushSyncFolderUpdates().then(() => {
            aFnResolve();
          }).catch(aErr => {
            handlePushSyncItemsError(aErr);
          });
        }
        else {
          aFnResolve();
        }
      }).catch(aErr => {
        console.error("Clippings/wx::clippingsMgr.js: gCmd.editFolderNameIntrl(): " + aErr);
        aFnReject(aErr);
      });
    });
  },

  editClippingNameIntrl: function (aClippingID, aName, aDestUndoStack)
  {
    let that = this;
    
    return new Promise((aFnResolve, aFnReject) => {
      let oldName = "";
      
      gClippingsDB.clippings.get(aClippingID).then(aClipping => {
        oldName = aClipping.name;

        if (aName == oldName) {
          return 0;
        }

	that.recentAction = that.ACTION_EDITNAME;
        return gClippingsSvc.updateClipping(aClippingID, { name: aName }, aClipping);

      }).then(aNumUpd => {
        if (aNumUpd && aDestUndoStack == that.UNDO_STACK) {
          that.undoStack.push({
            action: that.ACTION_EDITNAME,
            id: aClippingID,
            name: aName,
            oldName,
            itemType: that.ITEMTYPE_CLIPPING
          });
        }

        if (gSyncedItemsIDs[aClippingID + "C"]) {
          gClippings.pushSyncFolderUpdates().then(() => {
            aFnResolve();
          }).catch(aErr => {
            handlePushSyncItemsError(aErr);
          });
        }
        else {
          aFnResolve();
        }
      }).catch(aErr => {
        console.error("Clippings/wx::clippingsMgr.js: gCmd.editClippingNameIntrl(): " + aErr);
        aFnReject(aErr);
      });
    });
  },

  editClippingContentIntrl: function (aClippingID, aContent, aDestUndoStack)
  {
    let that = this;
    
    return new Promise((aFnResolve, aFnReject) => {
      let oldContent = "";
      
      gClippingsDB.clippings.get(aClippingID).then(aClipping => {
        oldContent = aClipping.content;

        if (aContent == oldContent) {
          return 0;
        }

	that.recentAction = that.ACTION_EDITCONTENT;
        return gClippingsSvc.updateClipping(aClippingID, { content: aContent }, aClipping);

      }).then(aNumUpd => {
        if (aNumUpd && aDestUndoStack == that.UNDO_STACK) {
          that.undoStack.push({
            action: that.ACTION_EDITCONTENT,
            id: aClippingID,
            content: aContent,
            oldContent,
            itemType: that.ITEMTYPE_CLIPPING
          });
        }

        if (gSyncedItemsIDs[aClippingID + "C"]) {
          gClippings.pushSyncFolderUpdates().then(() => {
            aFnResolve();
          }).catch(aErr => {
            handlePushSyncItemsError(aErr);
          });
        }
        else {
          aFnResolve();
        }
      }).catch(aErr => {
        console.error("Clippings/wx::clippingsMgr.js: gCmd.editClippingContentIntrl(): " + aErr);
        aFnReject(aErr);
      });
    });
  },
  
  setLabelIntrl: function (aClippingID, aLabel, aDestUndoStack)
  {
    let selectedNode = getClippingsTree().activateKey(aClippingID + "C");
    let oldLabel;

    this.recentAction = this.ACTION_SETLABEL;      

    gClippingsDB.clippings.get(aClippingID).then(aClipping => {
      oldLabel = aClipping.label;
      return gClippingsSvc.updateClipping(aClippingID, { label: aLabel }, aClipping);

    }).then(aNumUpd => {
      // Set the icon color on the tree list.
      if (selectedNode.extraClasses !== undefined) {
        let result = selectedNode.extraClasses.match(/ae\-clipping\-label\-[a-z]+/);
        if (result) {
          selectedNode.removeClass(result[0]);
        }
      }

      if (aLabel) {
        selectedNode.addClass(`ae-clipping-label-${aLabel}`);
      }

      gClippingLabelPicker.selectedLabel = aLabel;

      if (aDestUndoStack == this.UNDO_STACK) {
        this.undoStack.push({
          action: this.ACTION_SETLABEL,
          id: aClippingID,
          label: aLabel,
          oldLabel
        });
      }

      if (gSyncedItemsIDs[aClippingID + "C"]) {
        return gClippings.pushSyncFolderUpdates();
      }
    }).catch(aErr => {
      handlePushSyncItemsError(aErr);
      console.error("Clippings/wx::clippingsMgr.js: gCmd.setLabel(): " + aErr);
    });
  },
  
  updateDisplayOrder: function (aFolderID, aDestUndoStack, aUndoInfo, aSuppressClippingsMenuRebuild)
  {
    let tree = getClippingsTree();
    let folderNode;
    
    if (aFolderID == aeConst.ROOT_FOLDER_ID) {
      folderNode = tree.getRootNode();
    }
    else {
      folderNode = tree.getNodeByKey(aFolderID + "F");
    }

    return new Promise((aFnResolve, aFnReject) => {
      let childNodes = folderNode.getChildren();
      if (! childNodes) {  // Empty folder.
        aFnResolve();
        return;
      }
    
      this.recentAction = this.ACTION_CHANGEPOSITION;

      gClippingsDB.transaction("rw", gClippingsDB.folders, gClippingsDB.clippings, () => {
	let seqUpdates = [];
	
	for (let i = 0; i < childNodes.length; i++) {
          let key = childNodes[i].key;
          let suffix = key.substring(key.length - 1);
          let seq = (aFolderID == aeConst.ROOT_FOLDER_ID ? (i + 1) : i);

          if (suffix == "F") {
            let fldrSeqUpd = gClippingsSvc.updateFolder(parseInt(childNodes[i].key), { displayOrder: seq });
            seqUpdates.push(fldrSeqUpd);
          }
          else if (suffix == "C") {
            let clipSeqUpd = gClippingsSvc.updateClipping(parseInt(childNodes[i].key), { displayOrder: seq });
            seqUpdates.push(clipSeqUpd);
          }
	}

	Promise.all(seqUpdates).then(aNumUpd => {
          log(`Clippings/wx::clippingsMgr.js: gCmd.updateDisplayOrder(): Display order updates for each folder item is completed (folder ID = ${aFolderID})`);

          if (aDestUndoStack == this.UNDO_STACK) {
            this.undoStack.push(aUndoInfo);
          }

          if (! aSuppressClippingsMenuRebuild) {
            gClippings.rebuildContextMenu();
          }

          if (aFolderID == gClippings.getSyncFolderID() || gSyncedItemsIDs[aFolderID + "F"] !== undefined) {
            gClippings.pushSyncFolderUpdates().then(() => {
              log("Clippings/wx::clippingsMgr.js::gCmd.updateDisplayOrder(): Saved the display order for synced items.");
            });
          }

	  aFnResolve();
	});
      }).catch(aErr => {
	console.error("Clippings/wx::clippingsMgr.js::gCmd.updateDisplayOrder(): %s", aErr.message);
	aFnReject(aErr);
      });
    });
  },

  async gotoURL(aURL)
  {
    const DEFAULT_MAX_WIDTH = 1000;
    const DEFAULT_MAX_HEIGHT = 720;

    try {
      let openerWnd = await browser.windows.get(gOpenerWndID);
      browser.windows.create({
        url: aURL,
        type: "normal",
        state: "normal",
        width: openerWnd.width,
        height: openerWnd.height,
      });
    }
    catch (e) {
      warn("Clippings/wx::clippingsMgr.js: gCmd.gotoURL(): " + e);

      browser.windows.create({
        url: aURL,
        type: "normal",
        state: "normal",
        width: DEFAULT_MAX_WIDTH,
        height: DEFAULT_MAX_HEIGHT,
      });
    }
  },

  async pasteClipping(aClippingID)
  {
    if (ENABLE_PASTE_CLIPPING) {
      log(`Clippings/wx::clippingsMgr.js: gCmd.pasteClipping(): clipping ID = ${aClippingID}`);

      let resp = await browser.runtime.sendMessage({
        msgID: "paste-clipping-by-name",
        clippingID: aClippingID,
        fromClippingsMgr: true
      });
      
      // Must close this window, or else pasting won't work!
      closeWnd();
    }
    else {
      warn("Clippings/wx::clippingsMgr.js: gCmd.pasteClipping(): Action disabled");
    }
  },
  
  showShortcutList: function ()
  {
    gDialogs.shortcutList.showModal();
  },

  insertCustomPlaceholder: function ()
  {
    gDialogs.insCustomPlchldr.showModal();
  },

  insertNumericPlaceholder: function ()
  {
    gDialogs.insAutoIncrPlchldr.showModal();
  },

  insertFormattedDateTimePlaceholder: function ()
  {
    gDialogs.insDateTimePlchldr.showModal();
  },
  
  showHidePlaceholderToolbar: function ()
  {
    let currSetting = gClippings.getPrefs().clippingsMgrPlchldrToolbar;
    browser.storage.local.set({ clippingsMgrPlchldrToolbar: !currSetting });
    
    if (gIsClippingsTreeEmpty) {
      return;
    }

    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    if (! selectedNode) {
      return;
    }

    if (! selectedNode.isFolder()) {
      $("#placeholder-toolbar").toggle();
    }
  },
  
  showHideDetailsPane: function ()
  {
    let currSetting = gClippings.getPrefs().clippingsMgrDetailsPane;
    browser.storage.local.set({ clippingsMgrDetailsPane: !currSetting });

    if (gIsClippingsTreeEmpty) {
      return;
    }

    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    if (! selectedNode) {
      return;
    }

    if (! selectedNode.isFolder()) {
      $("#source-url-bar, #options-bar").toggle();
    }
  },

  showHideStatusBar: function ()
  {
    $("#status-bar").toggle();
    let isVisible = $("#status-bar").css("display") != "none";
    recalcContentAreaHeight(isVisible);
    
    browser.storage.local.set({ clippingsMgrStatusBar: isVisible });
  },
  
  async toggleMaximize()
  {
    let wnd = await browser.windows.getCurrent();
    let updWndInfo = {
      state: (wnd.state == "maximized" ? "normal" : "maximized")
    };
    
    let updWnd = browser.windows.update(browser.windows.WINDOW_ID_CURRENT, updWndInfo);
    gIsMaximized = updWnd.state == "maximized";
  },

  toggleMinimizeWhenInactive: function ()
  {
    let currSetting = gClippings.getPrefs().clippingsMgrMinzWhenInactv;
    browser.storage.local.set({ clippingsMgrMinzWhenInactv: !currSetting });
  },
  
  openExtensionPrefs: function ()
  {
    browser.runtime.openOptionsPage();
  },
  
  backup: function ()
  {
    const INCLUDE_SRC_URLS = true;

    this.recentAction = this.ACTION_BACKUP;
    setStatusBarMsg(browser.i18n.getMessage("statusSavingBkup"));

    let excludeSyncFldrID = null;
    let prefs = gClippings.getPrefs();
    if (prefs.syncClippings) {
      excludeSyncFldrID = prefs.syncFolderID;
    }

    let blobData;
    aeImportExport.exportToJSON(INCLUDE_SRC_URLS, false, aeConst.ROOT_FOLDER_ID, excludeSyncFldrID, true).then(aJSONData => {
      blobData = new Blob([aJSONData], { type: "application/json;charset=utf-8"});

      gSuppressAutoMinzWnd = true;

      let filename = aeConst.CLIPPINGS_BACKUP_FILENAME;
      if (prefs.backupFilenameWithDate) {
        filename = aeConst.CLIPPINGS_BACKUP_FILENAME_WITH_DATE.replace("%s", moment().format("YYYY-MM-DD"));
      }
      
      browser.downloads.download({
        url: URL.createObjectURL(blobData),
        filename,
        saveAs: true

      }).then(aDownldItemID => {
        setStatusBarMsg(browser.i18n.getMessage("statusSavingBkupDone"));
        gSuppressAutoMinzWnd = false;

        return browser.downloads.search({ id: aDownldItemID });

      }).then(aDownldItems => {

        if (aDownldItems && aDownldItems.length > 0) {
          let backupFilePath = aDownldItems[0].filename;
          gDialogs.backupConfirmMsgBox.setMessage(browser.i18n.getMessage("clipMgrBackupConfirm", backupFilePath));
          gDialogs.backupConfirmMsgBox.showModal();
        }

      }).catch(aErr => {
        if (aErr.fileName == "undefined") {
          setStatusBarMsg();
        }
        else {
          console.error(aErr);
          setStatusBarMsg(browser.i18n.getMessage("statusSavingBkupFailed"));
          window.alert(browser.i18n.getMessage("backupError", aErr));
        }
        gSuppressAutoMinzWnd = false;
      });
    }).catch(aErr => {
      window.alert("Sorry, an error occurred during the backup.\n\nDetails:\n" + getErrStr(aErr));
      setStatusBarMsg(browser.i18n.getMessage("statusSavingBkupFailed"));
    });
  },
  
  restoreFromBackup: function ()
  {
    gDialogs.importFromFile.mode = gDialogs.importFromFile.IMP_REPLACE;
    gDialogs.importFromFile.showModal();
  },
  
  importFromFile: function ()
  {
    gDialogs.importFromFile.mode = gDialogs.importFromFile.IMP_APPEND;
    gDialogs.importFromFile.showModal();
  },

  exportToFile: function ()
  {
    gDialogs.exportToFile.showModal();
  },

  reloadSyncFolder: function ()
  {
    this.recentAction = this.ACTION_RELOAD_SYNC_FLDR;   
    gClippings.refreshSyncedClippings();
    gDialogs.reloadSyncFolder.showModal();
  },
  
  removeAllSrcURLs: function ()
  {
    gDialogs.removeAllSrcURLs.showModal();
  },

  undo: function ()
  {
    if (this.undoStack.length == 0) {
      window.setTimeout(() => { gDialogs.noUndoNotify.openPopup() }, 100);
      return;
    }

    let undo = this.undoStack.pop();

    if (undo.action == this.ACTION_DELETECLIPPING) {
      this.moveClippingIntrl(undo.id, undo.parentFolderID);
      this.redoStack.push(undo);
    }
    else if (undo.action == this.ACTION_DELETEFOLDER) {
      this.moveFolderIntrl(undo.id, undo.parentFolderID);
      this.redoStack.push(undo);
    }
    else if (undo.action == this.ACTION_MOVETOFOLDER) {
      if (undo.itemType == this.ITEMTYPE_CLIPPING) {
        this.moveClippingIntrl(undo.id, undo.oldParentFldrID);
        this.redoStack.push(undo);
      }
      else if (undo.itemType == this.ITEMTYPE_FOLDER) {
        this.moveFolderIntrl(undo.id, undo.oldParentFldrID);
        this.redoStack.push(undo);
      }
    }
    else if (undo.action == this.ACTION_COPYTOFOLDER) {
      if (undo.itemType == this.ITEMTYPE_CLIPPING) {
        this.moveClippingIntrl(undo.id, aeConst.DELETED_ITEMS_FLDR_ID);
        this.redoStack.push(undo);
      }
      else if (undo.itemType == this.ITEMTYPE_FOLDER) {
        this.moveFolderIntrl(undo.id, aeConst.DELETED_ITEMS_FLDR_ID);
        this.redoStack.push(undo);
      }
    }
    else if (undo.action == this.ACTION_CREATENEW) {
      this.moveClippingIntrl(undo.id, aeConst.DELETED_ITEMS_FLDR_ID);
      this.redoStack.push(undo);
    }
    else if (undo.action == this.ACTION_CREATENEWFOLDER) {
      this.moveFolderIntrl(undo.id, aeConst.DELETED_ITEMS_FLDR_ID);
      this.redoStack.push(undo);
    }
    else if (undo.action == this.ACTION_EDITNAME) {
      if (undo.itemType == this.ITEMTYPE_CLIPPING) {
        this.editClippingNameIntrl(undo.id, undo.oldName).then(() => {
          let clpNode = getClippingsTree().activateKey(undo.id + "C");
          clpNode.title = undo.oldName;
          $("#clipping-name").val(undo.oldName).select();
          this.redoStack.push(undo);
        });
      }
      else if (undo.itemType == this.ITEMTYPE_FOLDER) {
        this.editFolderNameIntrl(undo.id, undo.oldName).then(() => {
          let fldrNode = getClippingsTree().activateKey(undo.id + "F");
          fldrNode.title = undo.oldName;
          $("#clipping-name").val(undo.oldName).select();
          this.redoStack.push(undo);
        });
      }
    }
    else if (undo.action == this.ACTION_EDITCONTENT) {
      this.editClippingContentIntrl(undo.id, undo.oldContent).then(() => {
        getClippingsTree().activateKey(undo.id + "C");
        $("#clipping-text").val(undo.oldContent).select();
        this.redoStack.push(undo);
      });
    }
    else if (undo.action == this.ACTION_SETLABEL) {
      this.setLabelIntrl(undo.id, undo.oldLabel);
      this.redoStack.push(undo);
    }
    else if (undo.action == this.ACTION_CHANGEPOSITION) {
      let tree = getClippingsTree();
      let itemNode = tree.getNodeByKey(undo.nodeKey);
      let parentFldrID = undo.parentFolderID;
      let redoNextSiblingNode = itemNode.getNextSibling();
      
      if (undo.nextSiblingNodeKey) {
        let nextSiblingNode = tree.getNodeByKey(undo.nextSiblingNodeKey);       
        log(`Clippings/wx::clippingsMgr.js: gCmd.undo(): Reordering the tree node (key=${itemNode.key}), placing it before sibling node (key=${undo.nextSiblingNodeKey})`);
        log(`Current next sibling node key: ${(redoNextSiblingNode ? redoNextSiblingNode.key : null)} (this will be saved to the Redo stack)`)
        itemNode.moveTo(nextSiblingNode, "before");
      }
      else {
        if (parentFldrID == aeConst.ROOT_FOLDER_ID) {
          let rootFldrNode = tree.rootNode;
          log(`Clippings/wx::clippingsMgr.js: gCmd.undo(): Moving the tree node (key=${itemNode.key}) back to be the last node of the root folder.`);
          itemNode.moveTo(rootFldrNode, "child");
        }
        else {
          let parentFldrNodeKey = parentFldrID + "F";
          log(`Clippings/wx::clippingsMgr.js: gCmd.undo(): Moving the tree node (key=${itemNode.key}) back to be the last node of its parent (key=${parentFldrNodeKey}).`);
          let parentFldrNode = tree.getNodeByKey(parentFldrID + "F");
          itemNode.moveTo(parentFldrNode, "child");
        }
      }

      this.updateDisplayOrder(parentFldrID);
      undo.nextSiblingNodeKey = redoNextSiblingNode ? redoNextSiblingNode.key : null;
      this.redoStack.push(undo);
    }
  },

  redo: function ()
  {
    if (this.redoStack.length == 0) {
      window.setTimeout(() => { gDialogs.noRedoNotify.openPopup() }, 100);
      return;
    }

    let redo = this.redoStack.pop();

    if (redo.action == this.ACTION_DELETECLIPPING) {
      this.moveClippingIntrl(redo.id, aeConst.DELETED_ITEMS_FLDR_ID);
      this.undoStack.push(redo);
    }
    else if (redo.action == this.ACTION_DELETEFOLDER) {
      this.moveFolderIntrl(redo.id, aeConst.DELETED_ITEMS_FLDR_ID);
      this.undoStack.push(redo);
    }
    else if (redo.action == this.ACTION_MOVETOFOLDER) {
      if (redo.itemType == this.ITEMTYPE_CLIPPING) {
        this.moveClippingIntrl(redo.id, redo.newParentFldrID);
        this.undoStack.push(redo);
      }
      else if (redo.itemType == this.ITEMTYPE_FOLDER) {
        this.moveFolderIntrl(redo.id, redo.newParentFldrID);
        this.undoStack.push(redo);
      }
    }
    else if (redo.action == this.ACTION_COPYTOFOLDER) {
      if (redo.itemType == this.ITEMTYPE_CLIPPING) {
        this.moveClippingIntrl(redo.id, redo.destFldrID);
        this.undoStack.push(redo);
      }
      else if (redo.itemType == this.ITEMTYPE_FOLDER) {
        this.moveFolderIntrl(redo.id, redo.destFldrID);
        this.undoStack.push(redo);
      }
    }
    else if (redo.action == this.ACTION_CREATENEW) {
      this.moveClippingIntrl(redo.id, redo.parentFldrID);
      this.undoStack.push(redo);
    }
    else if (redo.action == this.ACTION_CREATENEWFOLDER) {
      this.moveFolderIntrl(redo.id, redo.parentFldrID);
      this.undoStack.push(redo);
    }
    else if (redo.action == this.ACTION_EDITNAME) {
      if (redo.itemType == this.ITEMTYPE_CLIPPING) {
        this.editClippingNameIntrl(redo.id, redo.name).then(() => {
          let clpNode = getClippingsTree().activateKey(redo.id + "C");
          clpNode.title = redo.name;
          $("#clipping-name").val(redo.name).select();
          this.undoStack.push(redo);
        });
      }
      else if (redo.itemType == this.ITEMTYPE_FOLDER) {
        this.editFolderNameIntrl(redo.id, redo.name).then(() => {
          let fldrNode = getClippingsTree().activateKey(redo.id + "F");
          fldrNode.title = redo.name;
          $("#clipping-name").val(redo.name).select();
          this.undoStack.push(redo);
        });
      }
    }
    else if (redo.action == this.ACTION_EDITCONTENT) {
      this.editClippingContentIntrl(redo.id, redo.content).then(() => {
        getClippingsTree().activateKey(redo.id + "C");
        $("#clipping-text").val(redo.content).select();
        this.undoStack.push(redo);
      });
    }
    else if (redo.action == this.ACTION_SETLABEL) {
      this.setLabelIntrl(redo.id, redo.label);
      this.undoStack.push(redo);
    }
    else if (redo.action == this.ACTION_CHANGEPOSITION) {
      let tree = getClippingsTree();
      let itemNode = tree.getNodeByKey(redo.nodeKey);
      let parentFldrID = redo.parentFolderID;
      let undoNextSiblingNode = itemNode.getNextSibling();;

      if (redo.nextSiblingNodeKey) {
        let nextSiblingNode = tree.getNodeByKey(redo.nextSiblingNodeKey);       
        log(`Clippings/wx::clippingsMgr.js: gCmd.redo(): Reordering the tree node (key=${itemNode.key}), placing it before sibling node (key=${redo.nextSiblingNodeKey})`);
        itemNode.moveTo(nextSiblingNode, "before");
      }
      else {
        if (parentFldrID == aeConst.ROOT_FOLDER_ID) {
          let rootFldrNode = tree.rootNode;
          log(`Clippings/wx::clippingsMgr.js: gCmd.redo(): Moving the tree node (key=${itemNode.key}) back to be the last node of the root folder.`);
          itemNode.moveTo(rootFldrNode, "child");
        }
        else {
          let parentFldrNodeKey = parentFldrID + "F";
          log(`Clippings/wx::clippingsMgr.js: gCmd.redo(): Moving the tree node (key=${itemNode.key}) back to be the last node of its parent (key=${parentFldrNodeKey}).`);
          let parentFldrNode = tree.getNodeByKey(parentFldrID + "F");
          itemNode.moveTo(parentFldrNode, "child");
        }
      }

      this.updateDisplayOrder(parentFldrID);
      redo.nextSiblingNodeKey = undoNextSiblingNode ? undoNextSiblingNode.key : null;
      this.undoStack.push(redo);
    }
  },
  
  // Helper
  _getParentFldrIDOfTreeNode: function (aNode)
  {
    let rv = null;
    let parentNode = aNode.getParent();
    rv = (parentNode.isRootNode() ? aeConst.ROOT_FOLDER_ID : parseInt(parentNode.key));

    return rv;
  },

  _copyFolderHelper: function (aSrcFldrID, aTargFldrID)
  {
    return new Promise((aFnResolve, aFnReject) => {
      gClippingsDB.transaction("rw", gClippingsDB.clippings, gClippingsDB.folders, () => {
	gClippingsDB.folders.where("parentFolderID").equals(aSrcFldrID).each((aItem, aCursor) => {
          let folderCpy = {
            name: aItem.name,
            parentFolderID: aTargFldrID,
          };
          gClippingsSvc.createFolder(folderCpy).then(aNewSubFldrID => {
            gClippingsListener.copiedItems.push({
              id: aNewSubFldrID,
              itemType: gCmd.ITEMTYPE_FOLDER,
              name: folderCpy.name,
              parentFolderID: folderCpy.parentFolderID,
            });
            this._copyFolderHelper(aItem.id, aNewSubFldrID);
          });

	}).then(() => {
          return gClippingsDB.clippings.where("parentFolderID").equals(aSrcFldrID).each((aItem, aCursor) => {
            let clippingCpy = {
              name: aItem.name,
              content: aItem.content,
              shortcutKey: "",
              sourceURL: aItem.sourceURL,
              label: aItem.label,
              parentFolderID: aTargFldrID,
            };
            gClippingsSvc.createClipping(clippingCpy).then(aNewClippingID => {
              gClippingsListener.copiedItems.push({
                id: aNewClippingID,
                itemType: gCmd.ITEMTYPE_CLIPPING,
                name: clippingCpy.name,
                parentFolderID: clippingCpy.parentFolderID,
                label: clippingCpy.label,
              });
            });
          });
	}).then(() => {
	  aFnResolve();
	});
      }).catch(aErr => {
	console.error("Clippings/wx::clippingsMgr.js: gCmd._copyFolderHelper(): " + aErr);
	aFnReject(aErr);
      });
    });
  }
};


// Initializing Clippings Manager window
$(async () => {
  gClippings = browser.extension.getBackgroundPage();

  if (gClippings) {
    gClippingsDB = gClippings.getClippingsDB();
    log("Clippings/wx::clippingsMgr: Successfully opened Clippings DB");
  }
  else {
    console.error("Error initializing Clippings Manager: Failed to retrieve background page!");
    $("#clipping-name, #clipping-text, #source-url-bar, #options-bar").hide();
    showInitError();
    return;
  }

  aeImportExport.setDatabase(gClippingsDB);

  let platform = await browser.runtime.getPlatformInfo();
  gOS = platform.os;

  // Platform-specific initialization.
  if (gOS == "mac") {
    $("#status-bar").css({ backgroundImage: "none" });
  }

  let wndURL = new URL(window.location.href);
  gOpenerWndID = Number(wndURL.searchParams.get("openerWndID"));
  gIsBackupMode = wndURL.searchParams.get("backupMode") || false;
  
  gIsMaximized = false;

  if (DEBUG_WND_ACTIONS) {
    if (gClippings.getPrefs().clippingsMgrMinzWhenInactv === undefined) {
      browser.storage.local.set({ clippingsMgrMinzWhenInactv: true });
    }
  }

  let clippingsListeners = gClippings.getClippingsListeners();
  gClippingsListener.origin = aeConst.ORIGIN_CLIPPINGS_MGR;
  clippingsListeners.add(gClippingsListener);

  let prefs = gClippings.getPrefs();
  gSyncFolderID = prefs.syncFolderID;

  let syncClippingsListeners = gClippings.getSyncClippingsListeners();
  syncClippingsListeners.add(gSyncClippingsListener);
  
  initToolbar();
  initInstantEditing();
  gShortcutKey.init();
  gSrcURLBar.init();
  gClippingLabelPicker.init("#clipping-label-picker");
  initDialogs();
  buildClippingsTree();
  initTreeSplitter();
  initSyncItemsIDLookupList();

  browser.history.deleteUrl({ url: window.location.href });

  if (gIsBackupMode) {
    gCmd.backup();
  }
  else {
    if (prefs.syncClippings && prefs.cxtMenuSyncItemsOnly && prefs.clippingsMgrShowSyncItemsOnlyRem) {
      gDialogs.showOnlySyncedItemsReminder.showModal();
      browser.storage.local.set({ clippingsMgrShowSyncItemsOnlyRem: false });
    }
  }
  
  // Fix for Fx57 bug where bundled page loaded using
  // browser.windows.create won't show contents unless resized.
  // See <https://bugzilla.mozilla.org/show_bug.cgi?id=1402110>
  let wnd = await browser.windows.getCurrent();
  browser.windows.update(wnd.id, {
    width: wnd.width + 1,
    focused: true,
  });
});


// Reloading or closing Clippings Manager window
$(window).on("beforeunload", () => {
  if (! gIsReloading) {
    browser.runtime.sendMessage({ msgID: "close-clippings-mgr-wnd" });
  }

  let clippingsListeners = gClippings.getClippingsListeners();
  clippingsListeners.remove(gClippingsListener);

  let syncClippingsListeners = gClippings.getSyncClippingsListeners();
  syncClippingsListeners.remove(gSyncClippingsListener);
  
  gClippings.purgeFolderItems(aeConst.DELETED_ITEMS_FLDR_ID).catch(aErr => {
    console.error("Clippings/wx::clippingsMgr.js: $(window).on('beforeunload'): " + aErr);
  });
});


// Keyboard event handler
$(document).keydown(async (aEvent) => {
  if (! gClippings) {
    // Clippings Manager initialization failed.
    return;
  }
  
  const isMacOS = gClippings.getOS() == "mac";

  function isAccelKeyPressed()
  {
    if (isMacOS) {
      return aEvent.metaKey;
    }
    return aEvent.ctrlKey;
  }

  function isTextboxFocused(aEvent)
  {
    return (aEvent.target.tagName == "INPUT" || aEvent.target.tagName == "TEXTAREA");
  }

  aeDialog.hidePopups();
  
  // NOTE: CTRL+W/Cmd+W is automatically handled, so no need to define it here.
  if (aEvent.key == "F1") {
    if (aeDialog.isOpen()) {
      return;
    }

    if ($("#intro-content").css("display") == "none") {
      gDialogs.miniHelp.showModal();
    }
    else {
      gDialogs.genericMsgBox.showModal();
    }
  }
  else if (aEvent.key == "F2") {
    gCmd.redo();
  }
  else if (aEvent.key == "Enter") {
    if (gSrcURLBar.isEditing()) {
      gSrcURLBar.acceptEdit();
    }
    aeDialog.acceptDlgs();
  }
  else if (aEvent.key == "Escape") {
    if (gSearchBox.isActivated()) {
      gSearchBox.reset();
    }
    if (gSrcURLBar.isEditing()) {
      gSrcURLBar.cancelEdit();
    }
    aeDialog.cancelDlgs();
  }
  else if (aEvent.key == "Delete") {
    if (aEvent.target.tagName == "UL" && aEvent.target.classList.contains("ui-fancytree")) {
      gCmd.deleteClippingOrFolder(gCmd.UNDO_STACK);
    }
  }
  else if (aEvent.key == "/" || aEvent.key == "'") {
    if (! isTextboxFocused(aEvent)) {
      aEvent.preventDefault();
    }
  }
  else if (aEvent.key == "F5") {
    // Suppress browser reload.
    aEvent.preventDefault();
  }
  else if (aEvent.key == "F10" && isAccelKeyPressed()) {
    gCmd.toggleMaximize();
  }
  else if (aEvent.key.toUpperCase() == "A" && isAccelKeyPressed()) {
    if (! isTextboxFocused(aEvent)) {
      aEvent.preventDefault();
    }
  }
  else if (aEvent.key.toUpperCase() == "F" && isAccelKeyPressed()) {
    aEvent.preventDefault();
    $("#search-box").focus();
  }
  else if (aEvent.key.toUpperCase() == "Z" && isAccelKeyPressed()) {
    gCmd.undo();
  }
  else {
    // Ignore standard browser shortcut keys.
    let key = aEvent.key.toUpperCase();
    if (isAccelKeyPressed() && (key == "D" || key == "F" || key == "N" || key == "P"
                                || key == "R" || key == "S" || key == "U")) {
      aEvent.preventDefault();
    }
  }
});


$(window).on("contextmenu", aEvent => {
  if (aEvent.target.tagName != "INPUT" && aEvent.target.tagName != "TEXTAREA") {
    aEvent.preventDefault();
  }
});


$(window).on("click", aEvent => {
  // HACK!!
  if ($("#shortcut-list-popup").hasClass("panel-show")) {
    return;
  }
  
  aeDialog.hidePopups();
});


$(window).on("blur", aEvent => {
  if (gOS == "linux" || DEBUG_WND_ACTIONS) {
    if (gClippings.getPrefs().clippingsMgrMinzWhenInactv && !gSuppressAutoMinzWnd) {
      let updWndInfo = { state: "minimized" };
      browser.windows.update(browser.windows.WINDOW_ID_CURRENT, updWndInfo);
    }
  }
});


//
// Clippings Manager functions
//

function initToolbar()
{
  // Show or hide the details pane and status bar.
  if (! gClippings.getPrefs().clippingsMgrDetailsPane) {
    $("#source-url-bar, #options-bar").hide();
  }
  if (! gClippings.getPrefs().clippingsMgrStatusBar) {
    $("#status-bar").hide();
    recalcContentAreaHeight($("#status-bar").css("display") != "none");
  }

  $("#new-clipping").click(aEvent => { gCmd.newClipping(gCmd.UNDO_STACK) });
  $("#new-folder").click(aEvent => { gCmd.newFolder(gCmd.UNDO_STACK) });
  $("#move").attr("title", browser.i18n.getMessage("tbMoveOrCopy")).click(aEvent => {
    gCmd.moveClippingOrFolder();
  });
  $("#delete").attr("title", browser.i18n.getMessage("tbDelete")).click(aEvent => {
    gCmd.deleteClippingOrFolder(gCmd.UNDO_STACK);
  });
  $("#undo").attr("title", browser.i18n.getMessage("tbUndo")).click(aEvent => { gCmd.undo() });

  // Placeholder toolbar -> Presets menu
  $.contextMenu({
    selector: "#plchldr-presets",
    trigger: "left",

    events: {
      activated: function (aOptions) {
        $("#plchldr-presets").addClass("toolbar-button-menu-open");
      },

      hide: function (aOptions) {
        $("#plchldr-presets").removeClass("toolbar-button-menu-open");
      },
    },

    position: function (aOpt, aX, aY) {
      aX = undefined;
      aY = undefined;

      aOpt.$menu.position({
        my: "left top",
        at: "left bottom",
        of: $("#plchldr-presets"),
      });
    },

    callback: function (aItemKey, aOpt, aRootMenu, aOriginalEvent) {
      let contentTextArea = $("#clipping-text");
      contentTextArea.focus();

      function insertPlaceholder(aPlaceholder) {
        insertTextIntoTextbox(contentTextArea, aPlaceholder);
      }
      
      switch (aItemKey) {
      case "insDate":
        insertPlaceholder("$[DATE]");
        break;
        
      case "insTime":
        insertPlaceholder("$[TIME]");
        break;
        
      case "insAppName":
        insertPlaceholder("$[HOSTAPP]");
        break;
        
      case "insUserAgent":
        insertPlaceholder("$[UA]");
        break;
        
      case "insClippingName":
        insertPlaceholder("$[NAME]");
        break;
        
      case "insParentFolderName":
        insertPlaceholder("$[FOLDER]");
        break;

      case "insFormattedDateTime":
        gCmd.insertFormattedDateTimePlaceholder();
        break;
        
      default:
        window.alert("The selected action is not available right now.");
        break;
      }
    },

    items: {
      insDate: {
        name: browser.i18n.getMessage("mnuPlchldrDate"),
        className: "ae-menuitem"
      },

      insTime: {
        name: browser.i18n.getMessage("mnuPlchldrTime"),
        className: "ae-menuitem"
      },

      insAppName: {
        name: browser.i18n.getMessage("mnuPlchldrAppName"),
        className: "ae-menuitem"
      },

      insUserAgent: {
        name: browser.i18n.getMessage("mnuPlchldrUsrAgent"),
        className: "ae-menuitem"
      },

      insClippingName: {
        name: browser.i18n.getMessage("mnuPlchldrClipName"),
        className: "ae-menuitem"
      },

      insParentFolderName: {
        name: browser.i18n.getMessage("mnuPlchldrFldrName"),
        className: "ae-menuitem"
      },

      separator1: "--------",

      insFormattedDateTime: {
        name: browser.i18n.getMessage("mnuPlchldrFmtDateTime"),
        className: "ae-menuitem"
      },
    }
  });
  
  // Tools menu
  $.contextMenu({
    selector: "#clippings-mgr-options",
    trigger: "left",

    events: {
      activated: function (aOptions) {
        $("#clippings-mgr-options").addClass("toolbar-button-menu-open");
      },

      hide: function (aOptions) {
        $("#clippings-mgr-options").removeClass("toolbar-button-menu-open");
      }
    },
    
    position: function (aOpt, aX, aY) {
      aX = undefined;
      aY = undefined;

      aOpt.$menu.position({
        my: "left top",
        at: "left bottom",
        of: $("#clippings-mgr-options")
      });
    },
    
    callback: function (aItemKey, aOpt, aRootMenu, aOriginalEvent) {
      switch (aItemKey) {
      case "backup":
        gCmd.backup();
        break;
        
      case "restoreFromBackup":
        gCmd.restoreFromBackup();
        break;
        
      case "importFromFile":
        gCmd.importFromFile();
        break;

      case "exportToFile":
        gCmd.exportToFile();
        break;

      case "removeAllSrcURLs":
        gCmd.removeAllSrcURLs();
        break;

      case "togglePlchldrToolbar":
        gCmd.showHidePlaceholderToolbar();
        break;
        
      case "toggleDetailsPane":
        gCmd.showHideDetailsPane();
        break;

      case "toggleStatusBar":
        gCmd.showHideStatusBar();
        break;

      case "maximizeWnd":
        window.setTimeout(async () => { gCmd.toggleMaximize() }, 100);
        break;

      case "minimizeWhenInactive":
        gCmd.toggleMinimizeWhenInactive();
        break;
        
      case "openExtensionPrefs":
        gCmd.openExtensionPrefs();
        break;
        
      default:
        window.alert("The selected action is not available right now.");
        break;
      }
    },
    items: {
      backup: {
        name: browser.i18n.getMessage("mnuBackup"),
        className: "ae-menuitem",
        disabled: function (aKey, aOpt) {
          return (gIsClippingsTreeEmpty);
        }
      },
      restoreFromBackup: {
        name: browser.i18n.getMessage("mnuRestoreFromBackup"),
        className: "ae-menuitem"
      },
      separator1: "--------",
      importFromFile: {
        name: browser.i18n.getMessage("mnuImport"),
        className: "ae-menuitem"
      },
      exportToFile: {
        name: browser.i18n.getMessage("mnuExport"),
        className: "ae-menuitem",
        disabled: function (aKey, aOpt) {
          return (gIsClippingsTreeEmpty);
        }
      },
      separator2: "--------",
      removeAllSrcURLs: {
        name: browser.i18n.getMessage("mnuRemoveAllSrcURLs"),
        className: "ae-menuitem",
        disabled: function (aKey, aOpt) {
          return (gIsClippingsTreeEmpty);
        }
      },
      separator3: "--------",
      showHideSubmenu: {
        name: browser.i18n.getMessage("mnuShowHide"),
        items: {
          toggleDetailsPane: {
            name: browser.i18n.getMessage("mnuShowHideDetails"),
            className: "ae-menuitem",
            disabled: function (aKey, aOpt) {
              return (gIsClippingsTreeEmpty || isFolderSelected());
            },
            icon: function (aOpt, $itemElement, aItemKey, aItem) {
              if ($("#source-url-bar").css("display") != "none"
                  && $("#options-bar").css("display") != "none") {
                return "context-menu-icon-checked";
              }
            }
          },
          togglePlchldrToolbar: {
            name: browser.i18n.getMessage("mnuShowHidePlchldrBar"),
            className: "ae-menuitem",
            disabled: function (aKey, aOpt) {
              return (gIsClippingsTreeEmpty || isFolderSelected());
            },
            icon: function (aOpt, $itemElement, aItemKey, aItem) {
              if ($("#placeholder-toolbar").css("display") != "none") {
                return "context-menu-icon-checked";
              }
            }
          },         
          toggleStatusBar: {
            name: browser.i18n.getMessage("mnuShowHideStatusBar"),
            className: "ae-menuitem",
            icon: function (aOpt, $itemElement, aItemKey, aItem) {
              if ($("#status-bar").css("display") != "none") {
                return "context-menu-icon-checked";
              }
            }
          }
        }
      },
      maximizeWnd: {
        name: browser.i18n.getMessage("mnuMaximize"),
        className: "ae-menuitem",
        visible: function (aKey, aOpt) {
          return (gOS == "win" || DEBUG_WND_ACTIONS);
        },
        icon: function (aKey, aOpt) {
          if (gIsMaximized) {
            return "context-menu-icon-checked";
          }
        }
      },
      minimizeWhenInactive: {
        name: browser.i18n.getMessage("mnuMinimizeWhenInactive"),
        className: "ae-menuitem",
        visible: function (aKey, aOpt) {
          return (gOS == "linux" || DEBUG_WND_ACTIONS);
        },
        icon: function (aKey, aOpt) {
          if (gClippings.getPrefs().clippingsMgrMinzWhenInactv) {
            return "context-menu-icon-checked";
          }
        }
      },
      windowCmdsSeparator: {
        type: "cm_separator",
        visible: function (akey, aOpt) {
          return (gOS != "mac" || DEBUG_WND_ACTIONS);
        }
      },
      openExtensionPrefs: {
        name: browser.i18n.getMessage("mnuShowExtPrefs"),
        className: "ae-menuitem"
      }
    }
  });

  $("#custom-plchldr").click(aEvent => { gCmd.insertCustomPlaceholder() });
  $("#auto-incr-plchldr").click(aEvent => { gCmd.insertNumericPlaceholder() });
  $("#show-shortcut-list").click(aEvent => { gCmd.showShortcutList() });

  gSearchBox.init();
}


function initInstantEditing()
{
  $("#clipping-name").attr("placeholder", browser.i18n.getMessage("clipMgrNameHint")).blur(aEvent => {
    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    let name = aEvent.target.value;
    let id = parseInt(selectedNode.key);

    if (selectedNode.isFolder()) {
      if (name) {
        gCmd.editFolderNameIntrl(id, name, gCmd.UNDO_STACK);
      }
      else {
        aEvent.target.value = browser.i18n.getMessage("untitledFolder");
        gCmd.editFolderNameIntrl(id, browser.i18n.getMessage("untitledFolder"), gCmd.UNDO_STACK);
      }
    }
    else {
      if (name) {
        gCmd.editClippingNameIntrl(id, name, gCmd.UNDO_STACK);
      }
      else {
        aEvent.target.value = browser.i18n.getMessage("untitledClipping");
        gCmd.editClippingNameIntrl(id, browser.i18n.getMessage("untitledClipping"), gCmd.UNDO_STACK);
      }
    }
  });
  
  $("#clipping-text").attr("placeholder", browser.i18n.getMessage("clipMgrContentHint")).blur(aEvent => {
    let tree = getClippingsTree();
    let selectedNode = tree.activeNode;
    let id = parseInt(selectedNode.key);

    if (! selectedNode.folder) {
      let content = aEvent.target.value;
      gCmd.editClippingContentIntrl(id, content, gCmd.UNDO_STACK);
    }
  }).attr("spellcheck", gClippings.getPrefs().checkSpelling);
}


function initIntroBannerAndHelpDlg()
{
  const isMacOS = gClippings.getOS() == "mac";
  const isLinux = gClippings.getOS() == "linux";

  function buildKeyMapTable(aTableDOMElt)
  {
    let shctKeys = [];
    if (isMacOS) {
      shctKeys = ["\u2326", "esc", "\u2318F", "\u2318W", "\u2318Z", "F1", "F2", "\u2318F10"];
    }
    else {
      shctKeys = [
        browser.i18n.getMessage("keyDel"),
        browser.i18n.getMessage("keyEsc"),
        `${browser.i18n.getMessage("keyCtrl")}+F`,  // CTRL+F
        `${browser.i18n.getMessage("keyCtrl")}+W`,  // CTRL+W
        `${browser.i18n.getMessage("keyCtrl")}+Z`,  // CTRL+Z
        "F1",
        "F2",
        `${browser.i18n.getMessage("keyCtrl")}+F10`, // CTRL+F10
      ];
    }

    function buildKeyMapTableRow(aShctKey, aCmdL10nStrIdx)
    {
      let tr = document.createElement("tr");
      let tdKey = document.createElement("td");
      let tdCmd = document.createElement("td");
      tdKey.appendChild(document.createTextNode(aShctKey));
      tdCmd.appendChild(document.createTextNode(browser.i18n.getMessage(aCmdL10nStrIdx)));
      tr.appendChild(tdKey);
      tr.appendChild(tdCmd);

      return tr;
    }

    aTableDOMElt.appendChild(buildKeyMapTableRow(shctKeys[0], "clipMgrIntroCmdDel"));
    aTableDOMElt.appendChild(buildKeyMapTableRow(shctKeys[1], "clipMgrIntroCmdClearSrchBar"));
    aTableDOMElt.appendChild(buildKeyMapTableRow(shctKeys[2], "clipMgrIntroCmdSrch"));
    aTableDOMElt.appendChild(buildKeyMapTableRow(shctKeys[3], "clipMgrIntroCmdClose"));
    aTableDOMElt.appendChild(buildKeyMapTableRow(shctKeys[4], "clipMgrIntroCmdUndo"));
    aTableDOMElt.appendChild(buildKeyMapTableRow(shctKeys[5], "clipMgrIntroCmdShowIntro"));
    aTableDOMElt.appendChild(buildKeyMapTableRow(shctKeys[6], "clipMgrIntroCmdRedo"));

    if (! isLinux) {
      aTableDOMElt.appendChild(buildKeyMapTableRow(shctKeys[7], "clipMgrIntroCmdMaximize"));
    }
  }
 
  let shctKeyTbls = $(".shortcut-key-tbl");

  for (let tbl of shctKeyTbls) {
    buildKeyMapTable(tbl);
  }
}


function initDialogs()
{
  let osName = gClippings.getOS();
  $(".msgbox-icon").attr("os", osName);
  $("#import-dlg #restore-backup-warning > .warning-icon").attr("os", osName);

  const isMacOS = osName == "mac";

  initIntroBannerAndHelpDlg();

  gDialogs.shctKeyConflict = new aeDialog("#shortcut-key-conflict-msgbox");
  gDialogs.shctKeyConflict.onAccept = aEvent => {
    gDialogs.shctKeyConflict.close();

    // NOTE: As of Firefox 57b8, this doesn't do anything.
    $("#clipping-key")[0].selectedIndex = gShortcutKey.getPrevSelectedIndex();
  };

  gDialogs.clippingMissingSrcURL = new aeDialog("#clipping-missing-src-url-msgbar");
  gDialogs.noUndoNotify = new aeDialog("#no-undo-msgbar");
  gDialogs.noRedoNotify = new aeDialog("#no-redo-msgbar");

  gDialogs.shortcutList = new aeDialog("#shortcut-list-dlg");
  gDialogs.shortcutList.isInitialized = false;
  gDialogs.shortcutList.onInit = () => {
    let that = gDialogs.shortcutList;

    gClippings.getShortcutKeyPrefixStr().then(aKeybPasteKeys => {
      if (! that.isInitialized) {
        let shctPrefixKey = 0;
        $("#shortcut-instrxns").text(browser.i18n.getMessage("clipMgrShortcutHelpInstrxn", aKeybPasteKeys));
        let extVer = browser.runtime.getManifest().version;
        
        aeImportExport.setL10nStrings({
          shctTitle: browser.i18n.getMessage("expHTMLTitle"),
          hostAppInfo: browser.i18n.getMessage("expHTMLHostAppInfo", [extVer, gClippings.getHostAppName()]),
          shctKeyInstrxns: browser.i18n.getMessage("expHTMLShctKeyInstrxn"),
	  shctKeyCustNote: browser.i18n.getMessage("expHTMLShctKeyCustNote"),
          shctKeyColHdr: browser.i18n.getMessage("expHTMLShctKeyCol"),
          clippingNameColHdr: browser.i18n.getMessage("expHTMLClipNameCol"),
        });

        $("#export-shct-list").click(aEvent => {
          aeImportExport.getShortcutKeyListHTML(true).then(aHTMLData => {
            let blobData = new Blob([aHTMLData], { type: "text/html;charset=utf-8"});
            let downldOpts = {
              url: URL.createObjectURL(blobData),
              filename: aeConst.HTML_EXPORT_SHORTCUTS_FILENAME,
              saveAs: true,
            };
            return browser.downloads.download(downldOpts);

          }).catch(aErr => {
            if (aErr.fileName == "undefined") {
              // User cancel
            }
            else {
              console.error(aErr);
              window.alert("Sorry, an error occurred while creating the export file.\n\nDetails:\n" + getErrStr(aErr));
            }
          });
        });

        if (browser.i18n.getUILanguage() == "nl") {
          $("#shortcut-instrxns").css({ letterSpacing: "-0.31px" });
        }
        
        that.isInitialized = true;
      }

      aeImportExport.getShortcutKeyListHTML(false).then(aShctListHTML => {
        $("#shortcut-list-content").append(sanitizeHTML(aShctListHTML));
      }).catch(aErr => {
        console.error("Clippings/wx::clippingsMgr.js: gDialogs.shortcutList.onInit(): " + aErr);
      });
    });
  };
  gDialogs.shortcutList.onUnload = () => {
    $("#shortcut-list-content").empty();
  };

  gDialogs.insCustomPlchldr = new aeDialog("#custom-placeholder-dlg");
  gDialogs.insCustomPlchldr.isInitialized = false;
  gDialogs.insCustomPlchldr.validatePlaceholderName = function (aName) {
    if (aName.match(/[^a-zA-Z0-9_\u0080-\u00FF\u0100-\u017F\u0180-\u024F\u0400-\u04FF\u0590-\u05FF]/)) {
      return false;
    }
    return true;    
  };
  gDialogs.insCustomPlchldr.onInit = () => {
    let that = gDialogs.insCustomPlchldr;

    if (! that.isInitialized) {
      $("#custom-plchldr-name").prop("placeholder", browser.i18n.getMessage("placeholderNameHint"));
      $("#custom-plchldr-name").on("keydown", aEvent => {
        if ($(aEvent.target).hasClass("input-error")) {
          $(aEvent.target).removeClass("input-error");
        }
      });
      that.isInitialized = true;
    }
    
    $("#custom-plchldr-default-val").val("");
    $("#custom-plchldr-name").removeClass("input-error").val("");
  };
  gDialogs.insCustomPlchldr.onShow = () => {
    $("#custom-plchldr-name").focus();
  };
  gDialogs.insCustomPlchldr.onAccept = () => {
    let placeholderName = $("#custom-plchldr-name").val();
    if (! placeholderName) {
      $("#custom-plchldr-name").focus();
      return;
    }
    
    let that = gDialogs.insCustomPlchldr;
    if (! that.validatePlaceholderName(placeholderName)) {
      $("#custom-plchldr-name").addClass("input-error").focus();
      return;
    }

    let placeholderValue = $("#custom-plchldr-default-val").val();
    let placeholder = "$[" + placeholderName;

    if (placeholderValue) {
      placeholder = placeholder + "{" + placeholderValue + "}]";
    }
    else {
      placeholder = placeholder + "]";
    }

    let contentTextArea = $("#clipping-text");
    contentTextArea.focus();
    insertTextIntoTextbox(contentTextArea, placeholder);
    that.close();
  };

  gDialogs.insAutoIncrPlchldr = new aeDialog("#numeric-placeholder-dlg");
  gDialogs.insAutoIncrPlchldr.isInitialized = false;
  gDialogs.insAutoIncrPlchldr.onInit = () => {
    let that = gDialogs.insAutoIncrPlchldr;
    if (! that.isInitialized) {
      $("#numeric-plchldr-name").prop("placeholder", browser.i18n.getMessage("placeholderNameHint"));
      $("#numeric-plchldr-name").on("keydown", aEvent => {
        if ($(aEvent.target).hasClass("input-error")) {
          $(aEvent.target).removeClass("input-error");
        }
      });
      that.isInitialized = true;
    }
    $("#numeric-plchldr-name").removeClass("input-error").val("");
  };
  gDialogs.insAutoIncrPlchldr.onShow = () => {
    $("#numeric-plchldr-name").focus();
  };
  gDialogs.insAutoIncrPlchldr.onAccept = () => {
    let placeholderName = $("#numeric-plchldr-name").val();
    if (! placeholderName) {
      $("#numeric-plchldr-name").focus();
      return;
    }
    
    if (! gDialogs.insCustomPlchldr.validatePlaceholderName(placeholderName)) {
      $("#numeric-plchldr-name").addClass("input-error").focus();
      return;
    }

    let that = gDialogs.insAutoIncrPlchldr;
    let placeholder = "#[" + placeholderName + "]";

    let contentTextArea = $("#clipping-text");
    contentTextArea.focus();
    insertTextIntoTextbox(contentTextArea, placeholder);
    that.close();
  };

  gDialogs.insDateTimePlchldr = new aeDialog("#insert-date-time-placeholder-dlg");
  gDialogs.insDateTimePlchldr.dateFormats = [
    "dddd, MMMM Do, YYYY",
    "MMMM D, YYYY",
    "MM/DD/YYYY",
    "YYYY-MM-DD",
    "D MMMM YYYY",
    "D.M.YYYY",
    "DD-MMM-YYYY",
    "MM/DD/YYYY h:mm A",
    "ddd, MMM DD, YYYY hh:mm:ss A ZZ",
  ];
  gDialogs.insDateTimePlchldr.timeFormats = [
    "h:mm A",
    "HH:mm",
    "HH:mm:ss",
  ];
  gDialogs.insDateTimePlchldr.onInit = () => {
    let that = gDialogs.insDateTimePlchldr;

    let dtFmtList = $("#date-time-format-list")[0];

    if (gClippings.getOS() != "mac") {
      dtFmtList.setAttribute("size", "11");
    }

    let lang = browser.i18n.getUILanguage();
    if (lang.search(/en/) == -1) {
      // Handle non-English locales.
      that.dateFormats = [
        "LL",
        "ll",
        "l",
        "YYYY-MM-DD",
        "lll",
        "LLLL",
        "llll",
      ];
      that.timeFormats = [
        "LT",
      ];
    }
    
    let date = new Date();
    let defaultDateFmtOpt = document.createElement("option");
    defaultDateFmtOpt.setAttribute("value", "DATE");
    defaultDateFmtOpt.appendChild(document.createTextNode(date.toLocaleDateString()));
    dtFmtList.appendChild(defaultDateFmtOpt);

    for (let dateFmt of that.dateFormats) {
      let dateFmtOpt = document.createElement("option");
      dateFmtOpt.setAttribute("value", dateFmt);
      let dateFmtOptTxt = document.createTextNode(moment().format(dateFmt));
      dateFmtOpt.appendChild(dateFmtOptTxt);
      dtFmtList.appendChild(dateFmtOpt);
    }

    let defaultTimeFmtOpt = document.createElement("option");
    defaultTimeFmtOpt.setAttribute("value", "TIME");
    defaultTimeFmtOpt.appendChild(document.createTextNode(date.toLocaleTimeString()));
    dtFmtList.appendChild(defaultTimeFmtOpt);

    for (let timeFmt of that.timeFormats) {
      let timeFmtOpt = document.createElement("option");
      timeFmtOpt.setAttribute("value", timeFmt);
      let timeFmtOptTxt = document.createTextNode(moment().format(timeFmt));
      timeFmtOpt.appendChild(timeFmtOptTxt);
      dtFmtList.appendChild(timeFmtOpt);
    }
  };
  gDialogs.insDateTimePlchldr.onShow = () => {
    let fmtList = $("#date-time-format-list")[0];
    fmtList.focus();
    fmtList.selectedIndex = 0;
  };
  gDialogs.insDateTimePlchldr.onAccept = () => {
    let that = gDialogs.insDateTimePlchldr;

    let placeholder = "";
    let dtFmtList = $("#date-time-format-list")[0];
    let selectedFmt = dtFmtList.options[dtFmtList.selectedIndex].value;

    if (selectedFmt == "DATE" || selectedFmt == "TIME") {
      placeholder = "$[" + selectedFmt + "]";
    }
    else {
      if (dtFmtList.selectedIndex > that.dateFormats.length) {
        placeholder = "$[TIME(" + selectedFmt + ")]";
      }
      else {
        placeholder = "$[DATE(" + selectedFmt + ")]";
      }
    }

    that.close();

    let contentTextArea = $("#clipping-text");
    contentTextArea.focus();
    insertTextIntoTextbox(contentTextArea, placeholder);
  };
  gDialogs.insDateTimePlchldr.onUnload = () => {
    $("#date-time-format-list").empty();
  };
  
  gDialogs.importFromFile = new aeDialog("#import-dlg");
  gDialogs.importFromFile.IMP_APPEND = 0;
  gDialogs.importFromFile.IMP_REPLACE = 1;
  gDialogs.importFromFile.mode = gDialogs.importFromFile.IMP_APPEND;
  gDialogs.importFromFile.isInitialized = false;

  gDialogs.importFromFile.onInit = () => {
    let that = gDialogs.importFromFile;
    
    if (gDialogs.importFromFile.mode == gDialogs.importFromFile.IMP_REPLACE) {
      $("#import-clippings-label").text(browser.i18n.getMessage("labelSelBkupFile"));
      $("#import-clippings-replc-shct-keys-checkbox").hide();
      
      if (! gIsClippingsTreeEmpty) {
        $("#restore-backup-warning").show();
      }

      $("#import-dlg-action-btn").text(browser.i18n.getMessage("btnRestoreBkup"));
    }
    else {
      $("#import-clippings-label").text(browser.i18n.getMessage("labelSelImportFile"));
      $("#import-clippings-replc-shct-keys-checkbox").show();
      $("#restore-backup-warning").hide();
      $("#import-dlg-action-btn").text(browser.i18n.getMessage("btnImport"));
    }

    $("#import-clippings-file-path").val("");
    $("#import-dlg button.dlg-accept").attr("disabled", "true");
    gSuppressAutoMinzWnd = true;

    if (! that.isInitialized) {
      $("#import-clippings-file-upload").on("change", aEvent => {
        $("#import-error").text("").hide();

        let inputFileElt = aEvent.target;
        if (inputFileElt.files.length > 0) {
          let file = inputFileElt.files[0];

          if (aeImportExport.isValidFileType(file)) {
            $("#import-clippings-file-path").val(file.name);
            $("#import-dlg button.dlg-accept").removeAttr("disabled");
          }
          else {
            $("#import-clippings-file-path").val("");
            $("#import-dlg button.dlg-accept").attr("disabled", "true");
          }
        }
        if (gDialogs.importFromFile.mode == gDialogs.importFromFile.IMP_REPLACE
            && !gIsClippingsTreeEmpty) {
          $("#restore-backup-warning").show();
        }
      });
      that.isInitialized = true;
    }
  };
  gDialogs.importFromFile.onUnload = () => {   
    $("#import-error").text("").hide();
    $("#import-dlg #import-clippings-file-upload").val("");
    $("#import-clippings-replc-shct-keys")[0].checked = true;
    gSuppressAutoMinzWnd = false;
  };
  gDialogs.importFromFile.onAccept = aEvent => {
    let that = gDialogs.importFromFile;
    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
   
    function importFile(aAppendItems)
    {
      let inputFileElt = $("#import-clippings-file-upload")[0];
      let fileList = inputFileElt.files;

      if (fileList.length == 0) {
        return;
      }
      
      $("#import-progress-bar").show();

      let importFile = fileList[0];
      log(`Clippings Manager: Selected import file: '${importFile.name}'; file size: ${importFile.size} bytes`);

      let fileReader = new FileReader();
      fileReader.addEventListener("load", aEvent => {
        let rawData = aEvent.target.result;
        let replaceShortcutKeys = ($("#import-clippings-replc-shct-keys:checked").length > 0);
        
        try {
          if (importFile.name.endsWith(".json")) {
            aeImportExport.importFromJSON(rawData, replaceShortcutKeys, aAppendItems);
          }
          else if (importFile.name.endsWith(".rdf")) {
            aeImportExport.importFromRDF(rawData, replaceShortcutKeys, aAppendItems);
          }
        }
        catch (e) {
          $("#import-progress-bar").hide();
          console.error(e);
          $("#import-error").text(browser.i18n.getMessage("importError")).show();
          clippingsListeners.forEach(aListener => { aListener.importFinished(false) });

          return;
        }

        gClippings.setClippingsMgrRootFldrReseq(true);

        log("Clippings/wx::clippingsMgr.js: gDialogs.importFromFile.onAccept()::importFile(): Importing Clippings data asynchronously.");
        
        $("#import-error").text("").hide();
        $("#import-progress-bar").hide();
        gDialogs.importFromFile.close();
        gSuppressAutoMinzWnd = false;

        gDialogs.importConfirmMsgBox.setMessage(browser.i18n.getMessage("clipMgrImportConfirm", importFile.name));
        gDialogs.importConfirmMsgBox.showModal();
      });

      fileReader.readAsText(importFile);
    } // END nested function

    if (that.mode == that.IMP_REPLACE) {
      info("Clippings/wx::clippingsMgr.js: Import dialog mode: Restore From Backup");

      $("#restore-backup-warning").hide();
      
      gClippingsDB.transaction("rw", gClippingsDB.clippings, gClippingsDB.folders, () => {
        log("Clippings/wx::clippingsMgr.js: gDialogs.importFromFile.onAccept(): Starting restore from backup file.\nDeleting all clippings and folders (except the 'Synced Clippings' folder, if Sync Clippings turned on).");

        clippingsListeners.forEach(aListener => { aListener.importStarted() });       
	gCmd.recentAction = gCmd.ACTION_RESTORE_BACKUP;

        gClippingsDB.folders.each((aItem, aCursor) => {
          if ("isSync" in aItem) {
            // Don't delete the Synced Clippings folder.
            return;
          }

          let fldrID = aItem.id + "F";         
          if (! (fldrID in gSyncedItemsIDs)) {
            gClippingsSvc.deleteFolder(parseInt(fldrID));
          }
        }).then(() => {
          return gClippingsDB.clippings.each((aItem, aCursor) => {
            let clpgID = aItem.id + "C";
            if (! (clpgID in gSyncedItemsIDs)) {
              gClippingsSvc.deleteClipping(parseInt(clpgID));
            }
          });
        }).then(() => {
          log("Clippings/wx::clippingsMgr.js: Finished deleting clippings and folders. Starting import of backup file.");
          importFile(false);
        });
      }).catch(aErr => {
        console.error("Clippings/wx::clippingsMgr.js: gDialogs.importFromFile.onAccept(): " + aErr);
      });
    }
    else {
      info("Clippings/wx::clippingsMgr.js: Import dialog mode: Import File");
      gCmd.recentAction = gCmd.ACTION_IMPORT;
      clippingsListeners.forEach(aListener => { aListener.importStarted() });
      
      importFile(true);
    }
  };
  
  gDialogs.exportToFile = new aeDialog("#export-dlg");
  gDialogs.exportToFile.FMT_CLIPPINGS_WX = 0;
  gDialogs.exportToFile.FMT_HTML = 1;
  gDialogs.exportToFile.FMT_CSV = 2;
  gDialogs.exportToFile.inclSrcURLs = false;
  
  gDialogs.exportToFile.onInit = () => {
    let that = gDialogs.exportToFile;
    let fmtDesc = [
      browser.i18n.getMessage("expFmtClippings6Desc"), // Clippings 6
      browser.i18n.getMessage("expFmtHTMLDocDesc"),    // HTML Document
      browser.i18n.getMessage("expFmtCSVDesc"),        // CSV File
    ];

    that.inclSrcURLs = true;
    gSuppressAutoMinzWnd = true;

    // Fit text on one line for German locale.
    if (browser.i18n.getUILanguage() == "de") {
      $("#export-format-list-label").css({ letterSpacing: "-0.15px" });
      $("#include-src-urls + label").css({ letterSpacing: "-0.4px" });
    }
    
    $("#export-format-list").change(aEvent => {
      let selectedFmtIdx = aEvent.target.selectedIndex;
      $("#format-description").text(fmtDesc[selectedFmtIdx]);

      if (selectedFmtIdx == gDialogs.exportToFile.FMT_CLIPPINGS_WX) {
        $("#include-src-urls").removeAttr("disabled").prop("checked", that.inclSrcURLs);
      }
      else if (selectedFmtIdx == gDialogs.exportToFile.FMT_HTML
              || selectedFmtIdx == gDialogs.exportToFile.FMT_CSV) {
        $("#include-src-urls").attr("disabled", "true").prop("checked", false);
      }
    });

    $("#include-src-urls").click(aEvent => {
      that.inclSrcURLs = aEvent.target.checked;
    });

    $("#export-format-list")[0].selectedIndex = gDialogs.exportToFile.FMT_CLIPPINGS_WX;
    $("#format-description").text(fmtDesc[gDialogs.exportToFile.FMT_CLIPPINGS_WX]);
    $("#include-src-urls").prop("checked", that.inclSrcURLs);
  };

  gDialogs.exportToFile.onShow = () => {
    $("#export-format-list")[0].focus();
  };

  gDialogs.exportToFile.onAfterAccept = () => {
    function saveToFile(aBlobData, aFilename)
    {
      browser.downloads.download({
        url: URL.createObjectURL(aBlobData),
        filename: aFilename,
        saveAs: true
      }).then(aDownldItemID => {
        gSuppressAutoMinzWnd = false;
        setStatusBarMsg(browser.i18n.getMessage("statusExportDone"));

        return browser.downloads.search({ id: aDownldItemID });

      }).then(aDownldItems => {

        if (aDownldItems && aDownldItems.length > 0) {
          let exportFilePath = aDownldItems[0].filename;
          gDialogs.exportConfirmMsgBox.setMessage(browser.i18n.getMessage("clipMgrExportConfirm", exportFilePath));
          gDialogs.exportConfirmMsgBox.showModal();
        }
      }).catch(aErr => {
        gSuppressAutoMinzWnd = false;
        if (aErr.fileName == "undefined") {
          setStatusBarMsg();
        }
        else {
          console.error(aErr);
          setStatusBarMsg(browser.i18n.getMessage("statusExportFailed"));
          window.alert(browser.i18n.getMessage("exportError", aErr));
        }
      });
    }

    let excludeSyncFldrID = null;
    let prefs = gClippings.getPrefs();
    if (prefs.syncClippings) {
      excludeSyncFldrID = prefs.syncFolderID;
    }
    
    let selectedFmtIdx = $("#export-format-list")[0].selectedIndex;
    setStatusBarMsg(browser.i18n.getMessage("statusExportStart"));

    if (selectedFmtIdx == gDialogs.exportToFile.FMT_CLIPPINGS_WX) {
      let inclSrcURLs = $("#include-src-urls").prop("checked");

      aeImportExport.exportToJSON(inclSrcURLs, false, aeConst.ROOT_FOLDER_ID, excludeSyncFldrID, true).then(aJSONData => {
        let blobData = new Blob([aJSONData], { type: "application/json;charset=utf-8"});

        saveToFile(blobData, aeConst.CLIPPINGS_EXPORT_FILENAME);
	gCmd.recentAction = gCmd.ACTION_EXPORT;
	
      }).catch(aErr => {
        window.alert("Sorry, an error occurred while exporting to Clippings 6 format.\n\nDetails:\n" + getErrStr(aErr));
        setStatusBarMsg(browser.i18n.getMessage("statusExportFailed"));
        gSuppressAutoMinzWnd = false;
      });
    }
    else if (selectedFmtIdx == gDialogs.exportToFile.FMT_HTML) {
      aeImportExport.exportToHTML().then(aHTMLData => {
        let blobData = new Blob([aHTMLData], { type: "text/html;charset=utf-8"});
        saveToFile(blobData, aeConst.HTML_EXPORT_FILENAME);
	gCmd.recentAction = gCmd.ACTION_EXPORT;
	
      }).catch(aErr => {
        window.alert("Sorry, an error occurred while exporting to HTML Document format.\n\nDetails:\n" + getErrStr(aErr));
        setStatusBarMsg(browser.i18n.getMessage("statusExportFailed"));
        gSuppressAutoMinzWnd = false;
      });
    }
    else if (selectedFmtIdx == gDialogs.exportToFile.FMT_CSV) {
      aeImportExport.exportToCSV(excludeSyncFldrID).then(aCSVData => {
        let blobData = new Blob([aCSVData], { type: "text/csv;charset=utf-8" });
        saveToFile(blobData, aeConst.CSV_EXPORT_FILENAME);
	gCmd.recentAction = gCmd.ACTION_EXPORT;

      }).catch(aErr => {
        window.alert("Sorry, an error occurred while exporting to CSV format.\n\nDetails:\n" + getErrStr(aErr));
        setStatusBarMsg(browser.i18n.getMessage("statusExportFailed"));
        gSuppressAutoMinzWnd = false;
      });
    }
  };

  gDialogs.importConfirmMsgBox = new aeDialog("#import-confirm-msgbox");
  gDialogs.importConfirmMsgBox.setMessage = aMessage => {
    $("#import-confirm-msgbox > .msgbox-content").text(aMessage);
  };
  gDialogs.importConfirmMsgBox.onAfterAccept = () => {
    let clippingsListeners = gClippings.getClippingsListeners().getListeners();
    clippingsListeners.forEach(aListener => { aListener.importFinished(true) });
    window.location.reload();
  };

  gDialogs.exportConfirmMsgBox = new aeDialog("#export-confirm-msgbox");
  gDialogs.exportConfirmMsgBox.setMessage = aMessage => {
    $("#export-confirm-msgbox > .msgbox-content").text(aMessage);
  };

  gDialogs.backupConfirmMsgBox = new aeDialog("#backup-confirm-msgbox");
  gDialogs.backupConfirmMsgBox.setMessage = aMessage => {
    $("#backup-confirm-msgbox > .msgbox-content").text(aMessage);
  };
  gDialogs.backupConfirmMsgBox.onAfterAccept = () => {
    if (gIsBackupMode) {
      closeWnd();
    }
  };
  
  gDialogs.removeAllSrcURLs = new aeDialog("#remove-all-source-urls-dlg");
  $("#remove-all-source-urls-dlg > .dlg-btns > .dlg-btn-yes").click(aEvent => {
    gDialogs.removeAllSrcURLs.close();
    gCmd.recentAction = gCmd.ACTION_REMOVE_ALL_SRC_URLS;
    
    gClippingsDB.clippings.toCollection().modify({ sourceURL: "" }).then(aNumUpd => {
      gDialogs.removeAllSrcURLsConfirm.openPopup();
    });
  });

  gDialogs.removeAllSrcURLsConfirm = new aeDialog("#all-src-urls-removed-confirm-msgbar");
  gDialogs.removeAllSrcURLsConfirm.onInit = () => {
    // Reselect the selected tree node to force a call to updateDisplay().
    getClippingsTree().reactivate(true);
  };

  gDialogs.reloadSyncFolder = new aeDialog("#reload-sync-fldr-msgbox");
  gDialogs.reloadSyncFolder.onAfterAccept = () => {
    window.location.reload();
  };

  gDialogs.moveTo = new aeDialog("#move-dlg");
  gDialogs.moveTo.isInitialized = false;
  gDialogs.moveTo.fldrTree = null;
  gDialogs.moveTo.selectedFldrNode = null;

  gDialogs.moveTo.resetTree = function () {
    let that = gDialogs.moveTo;
    let fldrTree = that.fldrTree.getTree();
    fldrTree.clear();
    that.fldrTree = null;
    that.selectedFldrNode = null;

    // Destroy and then recreate the element used to instantiate Fancytree,
    // so that we start fresh when the dialog is invoked again.
    $("#move-to-fldr-tree").children().remove();
    let parentElt = $("#move-to-fldr-tree").parent();
    parentElt.children("#move-to-fldr-tree").remove();
    $('<div id="move-to-fldr-tree"></div>').insertAfter("#move-to-label");
  };

  gDialogs.moveTo.onInit = () => {
    let that = gDialogs.moveTo;

    if (! that.isInitialized) {
      $("#copy-instead-of-move").click(aEvent => {
        if (aEvent.target.checked) {
          if (getClippingsTree().activeNode.folder) {
            $("#move-to-label").text(browser.i18n.getMessage("labelCopyFolder"));
          }
          else {
            $("#move-to-label").text(browser.i18n.getMessage("labelCopyClipping"));
          }
          $("#move-dlg-action-btn").text(browser.i18n.getMessage("btnCopy"));
        }
        else {
          if (getClippingsTree().activeNode.folder) {
            $("#move-to-label").text(browser.i18n.getMessage("labelMoveFolder"));
          }
          else {
            $("#move-to-label").text(browser.i18n.getMessage("labelMoveClipping"));
          }
          $("#move-dlg-action-btn").text(browser.i18n.getMessage("btnMove"));
        }
      });
      that.isInitialized = true;
    }
    
    if (that.fldrTree) {
      that.fldrTree.getTree().getNodeByKey(Number(aeConst.ROOT_FOLDER_ID).toString()).setActive();
    }
    else {
      that.fldrTree = new aeFolderPicker("#move-to-fldr-tree", gClippingsDB);
      that.fldrTree.onSelectFolder = aFolderData => {
        that.selectedFldrNode = aFolderData.node;
      };
    }

    $("#copy-instead-of-move").prop("checked", false);
    $("#move-dlg-action-btn").text(browser.i18n.getMessage("btnMove"));
    $("#move-error").text("");
    that.selectedFldrNode = null;

    if (getClippingsTree().activeNode.folder) {
      $("#move-to-label").text(browser.i18n.getMessage("labelMoveFolder"));
    }
    else {
      $("#move-to-label").text(browser.i18n.getMessage("labelMoveClipping"));
    }
  };

  gDialogs.moveTo.onCancel = aEvent => {
    let that = gDialogs.moveTo;

    that.resetTree();
    that.close();
  };

  gDialogs.moveTo.onAccept = aEvent => {
    let that = gDialogs.moveTo;
    let clippingsMgrTree = getClippingsTree();
    let selectedNode = clippingsMgrTree.activeNode;
    let id = parseInt(selectedNode.key);
    let parentNode = selectedNode.getParent();

    // Handle case where default selection of root folder node wasn't changed.
    if (that.selectedFldrNode === null) {
      that.selectedFldrNode = that.fldrTree.getTree().getNodeByKey(Number(aeConst.ROOT_FOLDER_ID).toString());
    }
    
    let parentFolderID = (parentNode.isRootNode() ? aeConst.ROOT_FOLDER_ID : parseInt(parentNode.key));
    let destFolderID = parseInt(that.selectedFldrNode.key);

    log(`clippingsMgr.js: Move To dialog: ID of selected item: ${id}; it is ${selectedNode.isFolder()} that the selected item in the clippings tree is a folder; current parent of selected item: ${parentFolderID}; move or copy to folder ID: ${destFolderID}`);
    
    let makeCopy = $("#copy-instead-of-move").prop("checked");

    if (parentFolderID == destFolderID && !makeCopy) {
      $("#move-error").text(browser.i18n.getMessage("errMoveToSameParent"));
      return;
    }

    // Handle case where selected folder and destination folder are the same.
    if (selectedNode.isFolder() && id == destFolderID) {
      $("#move-error").text(browser.i18n.getMessage("errMoveToSubfldr"));
      return;
    }

    // Prevent infinite recursion when moving or copying a folder into one of
    // its subfolders.
    if (that.selectedFldrNode.isFolder()) {
      let parentNode, parentID;
      parentNode = that.selectedFldrNode.getParent();
      parentID = parentNode.isRootNode() ? aeConst.ROOT_FOLDER_ID : parseInt(parentNode.key);

      while (parentID != aeConst.ROOT_FOLDER_ID) {
        if (parentID == id) {
          $("#move-error").text(browser.i18n.getMessage("errMoveToSubfldr"));
          return;
        }
        parentNode = parentNode.getParent();
        parentID = parentNode.isRootNode() ? aeConst.ROOT_FOLDER_ID : parseInt(parentNode.key);
      }
    }

    if (selectedNode.isFolder()) {
      if (makeCopy) {
        gCmd.copyFolderIntrl(id, destFolderID, gCmd.UNDO_STACK);
      }
      else {
        gCmd.moveFolderIntrl(id, destFolderID, gCmd.UNDO_STACK);
      }
    }
    else {
      if (makeCopy) {
        gCmd.copyClippingIntrl(id, destFolderID, gCmd.UNDO_STACK);
      }
      else {
        gCmd.moveClippingIntrl(id, destFolderID, gCmd.UNDO_STACK);
      }
    }

    that.resetTree();
    that.close();
  };

  gDialogs.moveSyncFldr = new aeDialog("#move-sync-fldr-msgbox");
  gDialogs.deleteSyncFldr = new aeDialog("#delete-sync-fldr-msgbox");

  gDialogs.miniHelp = new aeDialog("#mini-help-dlg");
  if (! isMacOS) {
    let dlgHeight = "320px";
    // Accommodate extra line of text in German locale.
    if (browser.i18n.getUILanguage() == "de") {
      dlgHeight = "325px";
    }
    $("#mini-help-dlg").css({ height: dlgHeight });
  }

  gDialogs.showOnlySyncedItemsReminder = new aeDialog("#show-only-synced-items-reminder");
  gDialogs.genericMsgBox = new aeDialog("#generic-msg-box");
}


function getClippingsTree()
{
  let rv = $("#clippings-tree").fancytree("getTree");
  return rv;
}


function buildClippingsTree()
{
  let treeData = [];
  
  buildClippingsTreeHelper(aeConst.ROOT_FOLDER_ID).then(aTreeData => {
    if (aTreeData.length == 0) {
      treeData = setEmptyClippingsState();
    }
    else {
      treeData = aTreeData;
    }

    $("#clippings-tree").fancytree({
      extensions: ["dnd5", "filter"],

      debugLevel: 0,
      autoScroll: true,
      source: treeData,
      selectMode: 1,
      icon: (gIsClippingsTreeEmpty ? false : true),

      init: function (aEvent, aData) {
        let rootNode = aData.tree.getRootNode();
        if (rootNode.children.length > 0 && !gIsClippingsTreeEmpty) {
          rootNode.children[0].setActive();
        }
      },

      activate: function (aEvent, aData) {
        log("Clippings/wx::clippingsMgr.js: Activate event fired on clippings tree");
        updateDisplay(aEvent, aData);
      },

      async dblclick(aEvent, aData) {
        log("Clippings/wx::clippingsMgr.js: Double-click event fired on clippings tree");
        updateDisplay(aEvent, aData);

        if (aData.targetType == "title" || aData.targetType == "icon") {
          if (! aData.node.isFolder()) {
            let clippingID = parseInt(aData.node.key);
            gCmd.pasteClipping(clippingID);
          }
        }
      },

      dnd5: {
        autoExpandMS: 1000,
        preventRecursiveMoves: true,
        preventVoidMoves: true,
        scroll: true,

        dragStart: function (aNode, aData) {
          gReorderedTreeNodeNextSibling = aNode.getNextSibling();
          return true;
        },

        dragEnd: function (aNode, aData) {
          gReorderedTreeNodeNextSibling = null;
        },

        dragEnter: function (aNode, aData) {
          if (! aNode.isFolder()) {
            // Prevent attempt to drop a node into a non-folder node; in such a
            // case, only allow reordering of nodes.
            return ["before", "after"];
          }
          
          aData.dataTransfer.dropEffect = "move";
          return true;
        },

        dragDrop: function (aNode, aData) {
          if (gIsClippingsTreeEmpty) {
            return;
          }

          // Prevent dropping into a non-folder node.
          if (!aNode.isFolder() && aData.hitMode == "over") {
            return;
          }

          let parentNode = aNode.getParent();
          let clippingsListeners = gClippings.getClippingsListeners().getListeners();
          
          if (aData.otherNode) {           
            let newParentID = aeConst.ROOT_FOLDER_ID;

            if (aNode.isFolder() && aData.hitMode == "over") {
              newParentID = parseInt(aNode.key);
            }
            else {
              newParentID = (parentNode.isRootNode() ? aeConst.ROOT_FOLDER_ID : parseInt(parentNode.key));
            }

            let oldParentID;
            if (aData.otherNode.getParent().isRootNode()) {
              oldParentID = aeConst.ROOT_FOLDER_ID;
            }
            else {
              oldParentID = parseInt(aData.otherNode.getParent().key);
            }

            let id = parseInt(aData.otherNode.key);
            let prefs = gClippings.getPrefs();

            if (prefs.syncClippings && id == prefs.syncFolderID
                && newParentID != aeConst.ROOT_FOLDER_ID) {
              warn("The Synced Clippings folder cannot be moved.");
              return;
            }

            clippingsListeners.forEach(aListener => {
              aListener.dndMoveStarted();
            });

            aData.otherNode.moveTo(aNode, aData.hitMode);
            
            log(`Clippings/wx::clippingsMgr.js::#clippings-tree.dnd5.dragDrop(): ID of moved clipping or folder: ${id}\nID of old parent folder: ${oldParentID}\nID of new parent folder: ${newParentID}`);

            let isReordering = false;

            if (newParentID == oldParentID) {
              log(`It appears that the node (key = ${aData.otherNode.key}) was just reordered, as it was moved within the same folder. Rebuilding Clippings context menu.`);
              isReordering = true;
            }
            else {
              if (aData.otherNode.isFolder()) {
                gCmd.moveFolderIntrl(id, newParentID, gCmd.UNDO_STACK);
              }
              else {
                gCmd.moveClippingIntrl(id, newParentID, gCmd.UNDO_STACK);
              }
            }

            log("Clippings/wx::clippingsMgr.js::#clippings-tree.dnd5.dragDrop(): Updating display order");
            let destUndoStack = null;
            let undoInfo = null;
            
            if (isReordering) {
              let nextSiblingNode = gReorderedTreeNodeNextSibling;
              destUndoStack = gCmd.UNDO_STACK;
              
              undoInfo = {
                action: gCmd.ACTION_CHANGEPOSITION,
                id: parseInt(aData.otherNode.key),
                nodeKey: aData.otherNode.key,
                parentFolderID: newParentID,
                itemType: (aNode.folder ? gCmd.ITEMTYPE_FOLDER : gCmd.ITEMTYPE_CLIPPING),
                nextSiblingNodeKey: (nextSiblingNode ? nextSiblingNode.key : null),
              };
              log("Clippings/wx::clippingsMgr.js: Saving undo info for clipping/folder reordering:");
              log(undoInfo);
            }
            
            gCmd.updateDisplayOrder(oldParentID, destUndoStack, undoInfo, !isReordering).then(() => {
              if (isReordering) {
                clippingsListeners.forEach(aListener => {
                  aListener.dndMoveFinished();
                });
                return;
              }
              return gCmd.updateDisplayOrder(newParentID, null, null, false);
            }).then(() => {
	      if (newParentID != oldParentID) {
                aNode.setExpanded();
              }

              clippingsListeners.forEach(aListener => {
                aListener.dndMoveFinished();
              });
	    });
          }
          else {
            // Dropping a non-node.
            let dndData = aData.dataTransfer.getData("text");

            if (! dndData) {
              log("Clippings/wx::clippingsMgr.js: #clippings-tree.dnd5.dragDrop(): Non-node was dropped into tree.  Unable to process its data; ignoring.");
              return;
            }
            
            log("Clippings/wx::clippingsMgr.js: #clippings-tree.dnd5.dragDrop(): Non-node was dropped into tree.  Textual content detected.");
            
            aData.dataTransfer.effect = "copy";

            let parentID = aeConst.ROOT_FOLDER_ID;
            if (aNode.isFolder() && aData.hitMode == "over") {
              parentID = parseInt(aNode.key);
            }
            else {
              parentID = parentNode.isRootNode() ? aeConst.ROOT_FOLDER_ID : parseInt(parentNode.key);
            }

            let clipName = gClippings.createClippingNameFromText(dndData);
            let clipContent = dndData;

            gCmd.newClippingWithContent(parentID, clipName, clipContent, gCmd.UNDO_STACK);
	    
            if (aNode.isFolder()) {
              aNode.setExpanded();
            }
          }
        }
      },

      filter: {
        autoExpand: true,
        counter: false,
        highlight: true,
        mode: "hide"
      }
    });

    setStatusBarMsg(gIsClippingsTreeEmpty ? browser.i18n.getMessage("clipMgrStatusBar", "0") : null);

    // Context menu for the clippings tree.
    $.contextMenu({
      selector: "#clippings-tree > ul.ui-fancytree > li",

      events: {
        show: function (aOpts) {
          return (! gIsClippingsTreeEmpty);
        }
      },
      
      callback: function (aItemKey, aOpt, aRootMenu, aOriginalEvent) {
        function setLabel(aLabel) {
          let tree = getClippingsTree();
          let selectedNode = tree.activeNode;
          if (!selectedNode || selectedNode.isFolder()) {
            return;
          }

          let clippingID = parseInt(selectedNode.key);
          gCmd.setLabelIntrl(clippingID, aLabel, gCmd.UNDO_STACK);
        }
        
        switch (aItemKey) {
	case "reloadSyncFolder":
	  gCmd.reloadSyncFolder();
	  break;
	  
        case "moveOrCopy":
          gCmd.moveClippingOrFolder();
          break;
          
        case "deleteItem":
          gCmd.deleteClippingOrFolder(gCmd.UNDO_STACK);
          break;
          
        case "gotoSrcURL":
          let tree = getClippingsTree();
          let selectedNode = tree.activeNode;
          if (!selectedNode || selectedNode.isFolder()) {
            return;
          }

          let clippingID = parseInt(selectedNode.key);
          gClippingsDB.clippings.get(clippingID).then(async (aClipping) => {
            let srcURL = aClipping.sourceURL;
            if (srcURL == "") {
              gDialogs.clippingMissingSrcURL.openPopup();
              return;
            }
            gCmd.gotoURL(srcURL);
          });
          break;

        case "labelNone":
          setLabel("");
          break;
          
        case "labelRed":
        case "labelOrange":
        case "labelYellow":
        case "labelGreen":
        case "labelBlue":
        case "labelPurple":
        case "labelGrey":
          setLabel(aItemKey.substr(5).toLowerCase());
          break;

        default:
          window.alert("The selected action is not available right now.");
          break;
        }
      },
      
      items: {
        reloadSyncFolder: {
          name: browser.i18n.getMessage("mnuReloadSyncFldr"),
          className: "ae-menuitem",
          visible: function (aItemKey, aOpt) {
            let tree = getClippingsTree();
            let selectedNode = tree.activeNode;
            
            if (!selectedNode || !selectedNode.isFolder()) {
              return false;
            }

            let folderID = parseInt(selectedNode.key);
            return (folderID == gClippings.getSyncFolderID());
          }
        },

        moveOrCopy: {
          name: browser.i18n.getMessage("mnuMoveOrCopy"),
          className: "ae-menuitem",
          disabled: function (aKey, aOpt) {
            let tree = getClippingsTree();
            let selectedNode = tree.activeNode;

            if (! selectedNode) {
              return false;
            }

            let folderID = parseInt(selectedNode.key);
            return (folderID == gClippings.getSyncFolderID());
          }
        },
        gotoSrcURL: {
          name: browser.i18n.getMessage("mnuGoToSrcURL"),
          className: "ae-menuitem",
          visible: function (aItemKey, aOpt) {
            let tree = getClippingsTree();
            let selectedNode = tree.activeNode;
            if (!selectedNode || selectedNode.isFolder()) {
              return false;
            }
            return true;
          }
        },
        labelSubmenu: {
          name: browser.i18n.getMessage("mnuEditLabel"),
          visible: function (aItemKey, aOpt) {
            return (! isFolderSelected());
          },
          items: {
            labelNone: {
              name: browser.i18n.getMessage("none"),
              className: "ae-menuitem",
              icon: function (aOpt, $itemElement, aItemKey, aItem) {
                if (gClippingLabelPicker.selectedLabel == "") {
                  return "context-menu-icon-checked";
                }
              }
            },
            labelRed: {
              name: browser.i18n.getMessage("labelRed"),
              className: "ae-menuitem clipping-label-red",
              icon: function (aOpt, $itemElement, aItemKey, aItem) {
                if (gClippingLabelPicker.selectedLabel == aItemKey.substr(5).toLowerCase()) {
                  return "context-menu-icon-checked";
                }
              }
            },
            labelOrange: {
              name: browser.i18n.getMessage("labelOrange"),
              className: "ae-menuitem clipping-label-orange",
              icon: function (aOpt, $itemElement, aItemKey, aItem) {
                if (gClippingLabelPicker.selectedLabel == aItemKey.substr(5).toLowerCase()) {
                  return "context-menu-icon-checked";
                }
              }
            },
            labelYellow: {
              name: browser.i18n.getMessage("labelYellow"),
              className: "ae-menuitem clipping-label-yellow",
              icon: function (aOpt, $itemElement, aItemKey, aItem) {
                if (gClippingLabelPicker.selectedLabel == aItemKey.substr(5).toLowerCase()) {
                  return "context-menu-icon-checked";
                }
              }
            },
            labelGreen: {
              name: browser.i18n.getMessage("labelGreen"),
              className: "ae-menuitem clipping-label-green",
              icon: function (aOpt, $itemElement, aItemKey, aItem) {
                if (gClippingLabelPicker.selectedLabel == aItemKey.substr(5).toLowerCase()) {
                  return "context-menu-icon-checked";
                }
              }
            },
            labelBlue: {
              name: browser.i18n.getMessage("labelBlue"),
              className: "ae-menuitem clipping-label-blue",
              icon: function (aOpt, $itemElement, aItemKey, aItem) {
                if (gClippingLabelPicker.selectedLabel == aItemKey.substr(5).toLowerCase()) {
                  return "context-menu-icon-checked";
                }
              }
            },
            labelPurple: {
              name: browser.i18n.getMessage("labelPurple"),
              className: "ae-menuitem clipping-label-purple",
              icon: function (aOpt, $itemElement, aItemKey, aItem) {
                if (gClippingLabelPicker.selectedLabel == aItemKey.substr(5).toLowerCase()) {
                  return "context-menu-icon-checked";
                }
              }
            },
            labelGrey: {
              name: browser.i18n.getMessage("labelGrey"),
              className: "ae-menuitem clipping-label-grey",
              icon: function (aOpt, $itemElement, aItemKey, aItem) {
                if (gClippingLabelPicker.selectedLabel == aItemKey.substr(5).toLowerCase()) {
                  return "context-menu-icon-checked";
                }
              }
            },
          }
        },
        separator0: "--------",
        deleteItem: {
          name: browser.i18n.getMessage("tbDelete"),
          className: "ae-menuitem",
          disabled: function (aKey, aOpt) {
            let tree = getClippingsTree();
            let selectedNode = tree.activeNode;

            if (! selectedNode) {
              return false;
            }

            let folderID = parseInt(selectedNode.key);
            return (folderID == gClippings.getSyncFolderID());
          }
        }
      }
    });

    let prefs = gClippings.getPrefs();
    if (prefs.syncClippings) {
      gReloadSyncFldrBtn.show();
      $(".ae-synced-clippings-fldr").parent().addClass("ae-synced-clippings");

      if (prefs.cxtMenuSyncItemsOnly) {
        $("#clippings-tree").addClass("cxt-menu-show-sync-items-only");
      }
    }

    if (gClippings.isClippingsMgrRootFldrReseq()) {
      // This should only be performed after Clippings Manager is reloaded
      // following an import.
      gCmd.updateDisplayOrder(aeConst.ROOT_FOLDER_ID, null, null, true);
      gClippings.setClippingsMgrRootFldrReseq(false);
    }
    
  }).catch(aErr => {
    console.error("clippingsMgr.js::buildClippingsTree(): %s", aErr.message);
    showInitError();
  });
}


function buildClippingsTreeHelper(aFolderID)
{
  let rv = [];

  return new Promise((aFnResolve, aFnReject) => {
    gClippingsDB.transaction("r", gClippingsDB.folders, gClippingsDB.clippings, () => {
      gClippingsDB.folders.where("parentFolderID").equals(aFolderID).each((aItem, aCursor) => {
        let folderNode = {
          key: aItem.id + "F",
          title: sanitizeTreeNodeTitle(DEBUG_TREE ? `${aItem.name} [key=${aItem.id}F]` : aItem.name),
          folder: true
        }

        if (aItem.id == gClippings.getSyncFolderID()) {
          folderNode.extraClasses = "ae-synced-clippings-fldr";
        }

        if (! ("displayOrder" in aItem)) {
          folderNode.displayOrder = 0;
        }
        else {
          folderNode.displayOrder = aItem.displayOrder;
        }
        
        buildClippingsTreeHelper(aItem.id).then(aChildNodes => {
          folderNode.children = aChildNodes;
          rv.push(folderNode);
        });
      }).then(() => {
        return gClippingsDB.clippings.where("parentFolderID").equals(aFolderID).each((aItem, aCursor) => {
          let clippingNode = {
            key: aItem.id + "C",
            title: sanitizeTreeNodeTitle(DEBUG_TREE ? `${aItem.name} [key=${aItem.id}C]` : aItem.name)
          };
          if (aItem.label) {
            clippingNode.extraClasses = `ae-clipping-label-${aItem.label}`;
          }

          if (! ("displayOrder" in aItem)) {
            clippingNode.displayOrder = 0;
          }
          else {
            clippingNode.displayOrder = aItem.displayOrder;
          }

          rv.push(clippingNode);
        });
      }).then(() => {
        rv.sort((aItem1, aItem2) => {
          let rv = 0;
          if ("displayOrder" in aItem1 && "displayOrder" in aItem2) {
            rv = aItem1.displayOrder - aItem2.displayOrder;
          }
          return rv;
        });

        aFnResolve(rv);
      });
    }).catch(aErr => {
      console.error("Clippings/wx::clippingsMgr.js: buildClippingsTreeHelperEx(): %s", aErr.message);
      aFnReject(aErr);
    });
  });
}


function initSyncItemsIDLookupList()
{
  function initSyncItemsIDLookupListHelper(aFolderID)
  {
    return new Promise((aFnResolve, aFnReject) => {
      gClippingsDB.transaction("r", gClippingsDB.clippings, gClippingsDB.folders, () => {
        gClippingsDB.folders.where("parentFolderID").equals(aFolderID).each((aItem, aCursor) => {
          gSyncedItemsIDs[aItem.id + "F"] = 1;
          initSyncItemsIDLookupListHelper(aItem.id);
          
        }).then(() => {
          return gClippingsDB.clippings.where("parentFolderID").equals(aFolderID).each((aItem, aCursor) => {
            gSyncedItemsIDs[aItem.id + "C"] = 1;
          });

        }).then(() => {
          aFnResolve();
        });
      }).catch(aErr => {
        aFnReject(aErr);
      });
    });    
  }
  // END nested helper function

  return new Promise((aFnResolve, aFnReject) => {
    let prefs = gClippings.getPrefs();
    if (! prefs.syncClippings) {
      aFnResolve();
    }

    // Include the ID of the root Synced Clippings folder.
    gSyncedItemsIDs[prefs.syncFolderID + "F"] = 1;

    initSyncItemsIDLookupListHelper(prefs.syncFolderID).then(() => {
      aFnResolve();
    }).catch(aErr => {
      aFnReject(aErr);
    });
  });
}


function initTreeSplitter()
{
  // Adapted from https://codepen.io/lingtalfi/pen/zoNeJp
  // Requires Simple Drag library: https://github.com/lingtalfi/simpledrag
  var leftPane = document.getElementById("clippings-tree");
  var rightPane = document.getElementById("item-properties");
  var paneSep = document.getElementById("tree-splitter");

  // The script below constrains the target to move horizontally between a left and a right
  // virtual boundaries.
  // - the left limit is positioned at 10% of the screen width
  // - the right limit is positioned at 60% of the screen width
  var leftLimit = 10;
  var rightLimit = 60;

  paneSep.sdrag(function (el, pageX, startX, pageY, startY, fix) {

    fix.skipX = true;

    if (pageX < window.innerWidth * leftLimit / 100) {
      pageX = window.innerWidth * leftLimit / 100;
      fix.pageX = pageX;
    }
    if (pageX > window.innerWidth * rightLimit / 100) {
      pageX = window.innerWidth * rightLimit / 100;
      fix.pageX = pageX;
    }

    var cur = pageX / window.innerWidth * 100;
    if (cur < 0) {
      cur = 0;
    }
    if (cur > window.innerWidth) {
      cur = window.innerWidth;
    }


    var right = (100-cur-2);
    leftPane.style.width = cur + '%';
    rightPane.style.width = right + '%';

  }, null, 'horizontal');
}


function setEmptyClippingsState()
{
  var rv;
  rv = [{ title: browser.i18n.getMessage("clipMgrNoItems"), key: "0" }];
  gIsClippingsTreeEmpty = true;
  $("#clipping-name, #clipping-text, #placeholder-toolbar, #source-url-bar, #options-bar").hide();
  $("#intro-content").show();
  
  return rv;
}


function unsetEmptyClippingsState()
{
  let tree = getClippingsTree();
  let emptyMsgNode = tree.getNodeByKey("0");
  emptyMsgNode.remove();
  tree.options.icon = true;
  gIsClippingsTreeEmpty = false;
  $("#intro-content").hide();
  $("#clipping-name, #clipping-text").show();

  let prefs = gClippings.getPrefs();
  if (prefs.clippingsMgrDetailsPane) {
    $("#source-url-bar, #options-bar").show();
  }
  if (prefs.clippingsMgrPlchldrToolbar) {
    $("#placeholder-toolbar").show();
  }
}


function sanitizeTreeNodeTitle(aNodeTitle)
{
  let rv = "";
  rv = sanitizeHTML(aNodeTitle);
  rv = rv.replace(/</g, "&lt;");
  rv = rv.replace(/>/g, "&gt;");
  
  return rv;
}


function initShortcutKeyMenu()
{
  $("#clipping-key").change(aEvent => {
    let shortcutKeyMenu = aEvent.target;
    let shortcutKey = "";
    
    if (shortcutKeyMenu.selectedIndex != 0) {
      shortcutKey = shortcutKeyMenu.options[shortcutKeyMenu.selectedIndex].text;
    }

    // Check if the shortcut key is already assigned.
    let assignedKeysLookup = {};
    gClippingsDB.clippings.where("shortcutKey").notEqual("").each((aItem, aCursor) => {
      assignedKeysLookup[aItem.shortcutKey] = 1;
    }).then(() => {
      if (assignedKeysLookup[shortcutKey]) {
        gDialogs.shctKeyConflict.showModal();
        return;
      }

      let selectedNode = getClippingsTree().getActiveNode();
      if (! selectedNode) {
        console.warn("Can't set shortcut key if there is no clipping selected.");
        return;
      }

      let clippingID = parseInt(selectedNode.key);
      gClippingsSvc.updateClipping(clippingID, { shortcutKey });
    });
  });
}


function isFolderSelected()
{
  let selectedNode = getClippingsTree().activeNode;

  if (! selectedNode) {
    return undefined;
  }
  return selectedNode.isFolder();
}


function updateDisplay(aEvent, aData)
{
  if (gIsClippingsTreeEmpty) {
    $("#source-url-bar, #options-bar").hide();
    setStatusBarMsg(browser.i18n.getMessage("clipMgrStatusBar", "0"));
    return;
  }

  log("Clippings/wx::clippingsMgr.js: Updating display...");

  if (gSearchBox.isActivated()) {
    gSearchBox.updateSearch();
    let numMatches = gSearchBox.getCountMatches();
    if (numMatches !== undefined) {
      setStatusBarMsg(browser.i18n.getMessage("numMatches", numMatches));
    }
  }
  else {
    setStatusBarMsg();
  }

  if (gSrcURLBar.isEditing()) {
    gSrcURLBar.cancelEdit();
  }
  
  let selectedItemID = parseInt(aData.node.key);

  if (aData.node.isFolder()) {
    gClippingsDB.folders.get(selectedItemID).then(aResult => {
      $("#clipping-name").val(aResult.name);
      $("#clipping-text").val("").hide();

      $("#source-url-bar, #options-bar, #placeholder-toolbar").hide();
      $("#clipping-src-url").text("");
      let shortcutKeyMenu = $("#clipping-key")[0];
      shortcutKeyMenu.selectedIndex = 0;

      $("#item-properties").addClass("folder-only");

      let prefs = gClippings.getPrefs();
      if (prefs.syncClippings && selectedItemID == gClippings.getSyncFolderID()) {
        // Prevent renaming of the Synced Clippings folder.
        $("#clipping-name").attr("disabled", "true");
      }
      else {
        $("#clipping-name").removeAttr("disabled");
      }
    });
  }
  else {
    $("#item-properties").removeClass("folder-only");
    $("#clipping-name").removeAttr("disabled");
    
    gClippingsDB.clippings.get(selectedItemID).then(aResult => {
      $("#clipping-name").val(aResult.name);
      $("#clipping-text").val(aResult.content).show();

      if (gClippings.getPrefs().clippingsMgrDetailsPane) {
        $("#source-url-bar, #options-bar").show();
      }

      if (gClippings.getPrefs().clippingsMgrPlchldrToolbar) {
        $("#placeholder-toolbar").show();
      }
      
      if (aResult.sourceURL) {
        $("#clipping-src-url").html(sanitizeHTML(`<a href="${aResult.sourceURL}">${aResult.sourceURL}</a>`));
        $("#clipping-src-url > a").click(async (aEvent) => {
          aEvent.preventDefault();
          gCmd.gotoURL(aEvent.target.textContent);
        });
      }
      else {
        $("#clipping-src-url").text(browser.i18n.getMessage("none"));
      }
      
      let shortcutKeyMenu = $("#clipping-key")[0];
      shortcutKeyMenu.selectedIndex = 0;
      
      for (let i = 0; i < shortcutKeyMenu.options.length; i++) {
        if (shortcutKeyMenu[i].text == aResult.shortcutKey) {
          shortcutKeyMenu.selectedIndex = i;
          break;
        }
      }

      gClippingLabelPicker.selectedLabel = aResult.label;
    });
  }
}


function insertTextIntoTextbox(aTextboxElt, aInsertedText)
{
  let text, pre, post, pos;
  let textbox = aTextboxElt[0];
  
  text = textbox.value;

  if (textbox.selectionStart == textbox.selectionEnd) {
    var point = textbox.selectionStart;
    pre = text.substring(0, point);
    post = text.substring(point, text.length);
    pos = point + aInsertedText.length;
  }
  else {
    var p1 = textbox.selectionStart;
    var p2 = textbox.selectionEnd;
    pre = text.substring(0, p1);
    post = text.substring(p2, text.length);
    pos = p1 + aInsertedText.length;
  }

  textbox.value = pre + aInsertedText + post;
  textbox.selectionStart = pos;
  textbox.selectionEnd = pos;
}


function recalcContentAreaHeight(aIsStatusBarVisible)
{
  let statusBarHgt = aIsStatusBarVisible ? "var(--statusbar-height)" : "0px";
  $("#content").css({ height: `calc(100% - var(--toolbar-height) - ${statusBarHgt})`});
}


function setStatusBarMsg(aMessage)
{
  if (aMessage) {
    $("#status-bar-msg").text(aMessage);
    return;
  }

  let tree = getClippingsTree();
  $("#status-bar-msg").text(browser.i18n.getMessage("clipMgrStatusBar", tree.count()));
}


function closeWnd()
{
  browser.windows.remove(browser.windows.WINDOW_ID_CURRENT);
}


function showBanner(aMessage)
{
  let bannerElt = $("#banner");
  let bannerMsgElt = $("#banner-msg");

  bannerMsgElt.children().remove();
  bannerMsgElt.text(aMessage);
  bannerElt.css("display", "block");
}


//
// Error reporting and debugging output
//

function showInitError()
{
  let errorMsgBox = new aeDialog("#init-error-msgbox");
  errorMsgBox.onInit = () => {
    $("#init-error-msgbox > .dlg-content > .msgbox-error-msg").text(browser.i18n.getMessage("initError"));
  };
  errorMsgBox.onAccept = () => {
    closeWnd();
  };

  errorMsgBox.showModal();
}


function getErrStr(aErr)
{
  let rv = `${aErr.name}: ${aErr.message}`;

  if (aErr.fileName) {
    rv += "\nSource: " + aErr.fileName;
  }
  else {
    rv += "\nSource: unknown";
  }

  if (aErr.lineNumber) {
    rv += ":" + aErr.lineNumber;
  }

  return rv;
}


function handlePushSyncItemsError(aError)
{
  if (aError == aeConst.SYNC_ERROR_CONXN_FAILED && !gErrorPushSyncItems) {
    let errorMsgBox = new aeDialog("#sync-error-msgbox");
    errorMsgBox.onInit = () => {
      $("#sync-error-msgbox > .dlg-content > .msgbox-error-msg").text(browser.i18n.getMessage("syncPushFailed"));
    };
    errorMsgBox.showModal();
    gErrorPushSyncItems = true;
  }
}


function onError(aError)
{
  console.error(aError);
}


function log(aMessage)
{
  if (aeConst.DEBUG) { console.log(aMessage); }
}


function info(aMessage)
{
  if (aeConst.DEBUG) { console.info(aMessage); }
}


function warn(aMessage)
{
  if (aeConst.DEBUG) { console.warn(aMessage); }
}
