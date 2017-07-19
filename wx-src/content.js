/* -*- mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Clippings.
 *
 * The Initial Developer of the Original Code is 
 * Alex Eng <ateng@users.sourceforge.net>.
 * Portions created by the Initial Developer are Copyright (C) 2016-2017
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * ***** END LICENSE BLOCK ***** */


function handleRequestNewClipping(aRequest)
{
  let rv = null;
  let activeElt = window.document.activeElement;

  console.log("Clippings/wx: content.js::handleRequestNewClipping(): activeElt = " + (activeElt ? activeElt.toString() : "???"));

  if (isElementOfType(activeElt, "HTMLInputElement")
      || isElementOfType(activeElt, "HTMLTextAreaElement")) {
    // <input type="text"> or <textarea>
    let text = "";

    if (activeElt.selectionStart == activeElt.selectionEnd) {
      text = activeElt.value;
    }
    else {
      text = activeElt.value.substring(activeElt.selectionStart, 
                                       activeElt.selectionEnd);
    }

    rv = (text ? { content: text } : null);
  }
  else if (isElementOfType(activeElt, "HTMLBodyElement")) {
    let selection = activeElt.ownerDocument.getSelection();
    let text = selection.toString();

    rv = (text ? { content: text } : null);
  }

  if (rv !== null) {
    console.log("Content retrieved from " + activeElt.toString() + ": " + rv.content);
  }
  
  return rv;
}


function handleRequestInsertClipping(aRequest)
{
  let rv = false;
  let clippingText = aRequest.content;
  let activeElt = window.document.activeElement;

  console.log("Clippings/wx: content.js::handleRequestInsertClipping(): activeElt = " + (activeElt ? activeElt.toString() : "???"));  

  if (isElementOfType(activeElt, "HTMLInputElement")
      || isElementOfType(activeElt, "HTMLTextAreaElement")) {
    rv = insertTextIntoTextbox(activeElt, clippingText);
  }
  // Rich text editor
  else if (isElementOfType(activeElt, "HTMLIFrameElement")) {
    let doc = activeElt.contentDocument;
    rv = insertTextIntoRichTextEditor(doc, clippingText);
  }
  // Rich text editor used by Gmail and Outlook.com
  else if (isElementOfType(activeElt, "HTMLDivElement")) {
    let doc = activeElt.ownerDocument;
    rv = insertTextIntoRichTextEditor(doc, clippingText);
  }
  else {
    rv = false;
  }

  return rv;
}


//
// Helper functions
//

function isElementOfType(aElement, aTypeStr)
{
  let re = new RegExp(aTypeStr);
  return (aElement.toString().search(re) != -1);
}


function insertTextIntoTextbox(aTextboxElt, aInsertedText)
{
  console.log("Clippings/wx: insertTextIntoTextbox()");
  
  var text, pre, post, pos;
  text = aTextboxElt.value;

  if (aTextboxElt.selectionStart == aTextboxElt.selectionEnd) {
    var point = aTextboxElt.selectionStart;
    pre = text.substring(0, point);
    post = text.substring(point, text.length);
    pos = point + aInsertedText.length;
  }
  else {
    var p1 = aTextboxElt.selectionStart;
    var p2 = aTextboxElt.selectionEnd;
    pre = text.substring(0, p1);
    post = text.substring(p2, text.length);
    pos = p1 + aInsertedText.length;
  }

  aTextboxElt.value = pre + aInsertedText + post;
  aTextboxElt.selectionStart = pos;
  aTextboxElt.selectionEnd = pos;

  return true;
}


function insertTextIntoRichTextEditor(aRichTextEditorDocument, aClippingText)
{
  console.log("Clippings/wx: insertTextIntoRichTextEditor()");

  let hasHTMLTags = aClippingText.search(/<[a-z1-6]+( [a-z]+(\="?.*"?)?)*>/i) != -1;
  let hasRestrictedHTMLTags = aClippingText.search(/<\?|<%|<!DOCTYPE|(<\b(html|head|body|meta|script|applet|embed|object|i?frame|frameset)\b)/i) != -1;
  let clippingText = aClippingText;

  if (hasHTMLTags) {
    if (hasRestrictedHTMLTags) {
      clippingText = clippingText.replace(/&/g, "&amp;");
      clippingText = clippingText.replace(/</g, "&lt;");
      clippingText = clippingText.replace(/>/g, "&gt;");
    }
  }
  else {
    // Could be plain text but with angle brackets, e.g. for denoting URLs
    // or email addresses, e.g. <joel_user@acme.com>, <http://www.acme.com>
    let hasOpenAngleBrackets = clippingText.search(/</) != -1;
    let hasCloseAngleBrackets = clippingText.search(/>/) != -1;

    if (hasOpenAngleBrackets) {
      clippingText = clippingText.replace(/</g, "&lt;");
    }
    if (hasCloseAngleBrackets) {
      clippingText = clippingText.replace(/>/g, "&gt;");	  
    }
  }

  // TO DO: Get this from user pref.
  let autoLineBreak = true;
  
  let hasLineBreakTags = clippingText.search(/<br|<p/i) != -1;
  if (autoLineBreak && !hasLineBreakTags) {
    clippingText = clippingText.replace(/\n/g, "<br>");
  }

  try {
    aRichTextEditorDocument.execCommand("insertHTML", false, clippingText);
  }
  catch (e) {}

  return true;
}


//
// Message listeners
//

chrome.runtime.onMessage.addListener((aRequest, aSender, aSendResponse) => {
  console.log("Clippings/wx: Content script received message '" + aRequest.msgID + "' from extension");

  let resp = null;
  
  if (aRequest.msgID == "ae-clippings-new") {
    resp = handleRequestNewClipping(aRequest);
  }
  else if (aRequest.msgID == "ae-clippings-paste") {
    resp = handleRequestInsertClipping(aRequest);
  }

  if (resp !== null) {
    aSendResponse(resp);
  }
});


