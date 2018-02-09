/* -*- mode: javascript; tab-width: 8; indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let gClippings;


// Options page initialization
$(() => {
  chrome.runtime.getBackgroundPage(aBkgrdWnd => {
    gClippings = aBkgrdWnd;

    init();
  });
});


function init()
{
  let os = gClippings.getOS();
  let keybPasteKeys = aeConst.SHORTCUT_KEY_PREFIX;
  
  if (os == "mac") {
    keybPasteKeys = aeConst.SHORTCUT_KEY_PREFIX_MAC;
  }
  $("#enable-shortcut-key-label").text(chrome.i18n.getMessage("prefsShortcutMode", keybPasteKeys));
  
  browser.storage.local.get().then(aPrefs => {
    $("#html-paste-options").val(aPrefs.htmlPaste).change(aEvent => {
      setPref({ htmlPaste: aEvent.target.value });
    });
    
    $("#html-auto-line-break").attr("checked", aPrefs.autoLineBreak).click(aEvent => {
      setPref({ autoLineBreak: aEvent.target.checked });
    });

    $("#enable-shortcut-key").attr("checked", aPrefs.keyboardPaste).click(aEvent => {
      setPref({ keyboardPaste: aEvent.target.checked })
    });
    
    $("#auto-inc-plchldrs-start-val").val(aPrefs.autoIncrPlcHldrStartVal).click(aEvent => {
      setPref({ autoIncrPlcHldrStartVal: aEvent.target.valueAsNumber });
    });

    $("#always-save-src-url").attr("checked", aPrefs.alwaysSaveSrcURL).click(aEvent => {
      setPref({ alwaysSaveSrcURL: aEvent.target.checked });
    });

    $("#check-spelling").attr("checked", aPrefs.checkSpelling).click(aEvent => {
      setPref({ checkSpelling: aEvent.target.checked });
    });
  });
}


function setPref(aPref)
{
  browser.storage.local.set(aPref);
}


$(window).on("contextmenu", aEvent => {
  if (aEvent.target.tagName != "INPUT" && aEvent.target.tagName != "TEXTAREA") {
    aEvent.preventDefault();
  }
});
