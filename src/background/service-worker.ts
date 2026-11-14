// Background service worker: opens the side panel, adds context menu entries and marks tender pages.
// No state lives here (service workers are stopped when idle); hand-offs go through chrome.storage.session.

const TENDER_PAGES = [
  /^https:\/\/ezamowienia\.gov\.pl\//,
  /^https:\/\/bazakonkurencyjnosci\.funduszeeuropejskie\.gov\.pl\//,
  /^https:\/\/ted\.europa\.eu\//,
];

const MENU_SELECTION = 'tl-analyze-selection';
const MENU_PDF = 'tl-analyze-pdf';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error(e));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SELECTION, title: 'Analyze selected text with Tender Lens', contexts: ['selection'] });
    chrome.contextMenus.create({
      id: MENU_PDF,
      title: 'Analyze this PDF with Tender Lens',
      contexts: ['link'],
      targetUrlPatterns: ['*://*/*.pdf', '*://*/*.PDF', '*://*/*.pdf?*', 'https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/api/files/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // sidePanel.open() must run synchronously inside the user gesture, before any await.
  if (tab?.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.error(e));
  }
  const pending =
    info.menuItemId === MENU_SELECTION
      ? { type: 'selection', text: info.selectionText ?? '', url: info.pageUrl ?? '', at: Date.now() }
      : { type: 'pdf-link', text: '', url: info.linkUrl ?? '', at: Date.now() };
  chrome.storage.session.set({ pending }).catch((e) => console.error(e));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const isTender = TENDER_PAGES.some((re) => re.test(tab.url!));
  try {
    await chrome.action.setBadgeText({ tabId, text: isTender ? 'BID' : '' });
    if (isTender) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0f766e' });
  } catch {
    /* tab closed meanwhile */
  }
});
