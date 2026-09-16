/* Test-only: the production Spaces button in a disposable Thunderbird profile. */
"use strict";
(function (exports) {
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  Cu.importGlobalProperties(["IOUtils", "PathUtils"]);
  async function waitFor(predicate, label) {
    const end = Date.now() + 10000;
    while (Date.now() < end) { const value = predicate(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  exports.checkSharedSpace = async (context, profile) => {
    const checks = [], check = (name, value) => { if (!value) throw new Error(name); checks.push(name); };
    const win = await waitFor(() => Services.wm.getMostRecentWindow("mail:3pane"), "mail window");
    const doc = win.document, title = context.extension.localeData.localizeMessage("sharedSpaceTitle");
    const buttons = () => [...doc.querySelectorAll(".spaces-addon-button")].filter(button => button.title === title);
    const button = await waitFor(() => buttons()[0], "shared filters sidebar button");
    const img = button.querySelector("img"), box = button.getBoundingClientRect();
    check("native sidebar has one labelled shared filters icon with light and dark variants", buttons().length === 1 &&
      box.width > 0 && box.height > 0 && img.style.cssText.includes("shared-filters.svg") && img.style.cssText.includes("shared-filters-light.svg"));
    const tabmail = doc.getElementById("tabmail"), original = tabmail.currentTabInfo, count = tabmail.tabInfo.length;
    const url = context.extension.baseURI.resolve("options/shared-filters.html");
    const tabs = new Set();
    const opened = () => tabmail.currentTabInfo.browser?.currentURI.spec === url && tabmail.currentTabInfo.title === "Shared filters"
      ? tabmail.currentTabInfo : null;
    try {
      button.click(); const first = await waitFor(opened, "shared manager tab"); tabs.add(first);
      check("native sidebar click opens and selects the shared manager in a new tab", tabmail.tabInfo.length === count + 1 && button.classList.contains("current"));
      tabmail.switchToTab(original); button.click(); await waitFor(() => tabmail.currentTabInfo === first, "existing manager tab");
      check("native sidebar returns to its existing manager tab without duplicates", tabmail.tabInfo.length === count + 1);
      tabmail.closeTab(first); tabs.delete(first); button.click();
      const second = await waitFor(opened, "reopened shared manager"); tabs.add(second);
      check("native sidebar reopens the manager after its tab is closed", second !== first && tabmail.tabInfo.length === count + 1);
      const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(new win.DOMRect(0, 0, win.innerWidth, win.innerHeight), 1, "white");
      const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      await IOUtils.write(PathUtils.join(profile, "native-shared-space.png"), new Uint8Array(await blob.arrayBuffer())); bitmap.close();
    } finally { for (const tab of tabs) if (tabmail.tabInfo.includes(tab)) tabmail.closeTab(tab); }
    return checks;
  };
})(this);
