(function () {
  localStorage.removeItem('sms_custom_contacts');

  const table = document.getElementById('MainContent_GridView1');
  if (!table) return;

  // --- משתני מצב גלובליים ---
  let siteContacts = [];
  let contactsByPhone = {};
  let pinnedContacts = JSON.parse(localStorage.getItem('sms_pinned_contacts') || '[]');
  let quickTemplates = JSON.parse(localStorage.getItem('sms_quick_templates') || '["תודה רבה!", "אחזור אליך בהקדם.", "אני בדרך.", "התקבל, תודה."]');
  let draftsByContact = JSON.parse(localStorage.getItem('sms_drafts_by_contact') || '{}');
  let unreadCounts = JSON.parse(localStorage.getItem('sms_unread_counts') || '{}');
  let allMessages = [];
  let activeContact = null;
  let activeFilterTab = 'all'; // 'all' | 'incoming' | 'outgoing' | 'unanswered'
  let soundEnabled = localStorage.getItem('sms_sound_enabled') !== 'false';
  let selectedSoundType = localStorage.getItem('sms_sound_type') || 'double_bell';
  let knownMessageIds = new Set();

  // --- משתני ניהול טעינת היסטוריה הדרגתית ---
  let historyDocState = document;
  let highestLoadedPage = 1;
  let isLoadingHistory = false;
  let noMoreHistoryPages = false;

  function normalizePhone(num) {
    if (!num) return '';
    let clean = num.replace(/[\s\-()]/g, '');
    if (clean.startsWith('+972')) clean = '0' + clean.slice(4);
    if (clean.startsWith('972') && clean.length === 12) clean = '0' + clean.slice(3);
    return clean;
  }

  function getDisplayName(number) {
    const norm = normalizePhone(number);
    return contactsByPhone[norm]?.name || contactsByPhone[number]?.name || number;
  }

  function saveDraftsStorage() {
    localStorage.setItem('sms_drafts_by_contact', JSON.stringify(draftsByContact));
  }

  function saveUnreadStorage() {
    localStorage.setItem('sms_unread_counts', JSON.stringify(unreadCounts));
    updateTabIconAndTitle();
  }

  function cleanIncomingMessageBody(text, senderNumber, rawNum) {
    if (!text) return '';
    let cleaned = text
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      .trim();

    const contactName = contactsByPhone[senderNumber]?.name;
    const prefixes = [];
    if (contactName) prefixes.push(contactName);
    if (senderNumber) prefixes.push(senderNumber);
    if (rawNum && rawNum !== senderNumber) prefixes.push(rawNum);
    if (senderNumber && senderNumber.startsWith('0')) {
      prefixes.push('972' + senderNumber.slice(1));
      prefixes.push('+972' + senderNumber.slice(1));
    }

    for (const p of prefixes) {
      if (!p) continue;
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped}(?:\\s*[:\\-–]\\s*|\\s*\\n+)`, 'i');
      if (regex.test(cleaned)) {
        cleaned = cleaned.replace(regex, '');
        break;
      }
    }
    return cleaned.trim();
  }

  function formatMessageTextWithLinks(str) {
    const escaped = escapeHtml(str || '');
    const urlRegex = /((?:https?:\/\/|www\.)[^\s<]+)/gi;
    return escaped.replace(urlRegex, (url) => {
      const href = url.startsWith('http') ? url : `https://${url}`;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
  }

  // --- 0. עדכון אייקון הכרטיסייה (Favicon) וכותרת הכרטיסייה ---
  function updateTabIconAndTitle() {
    const totalUnread = Object.values(unreadCounts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    document.title = totalUnread > 0 ? `(${totalUnread}) הודעות SMS` : 'הודעות SMS';

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#008069';
    ctx.beginPath();
    ctx.roundRect(4, 8, 56, 44, 12);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(16, 52);
    ctx.lineTo(10, 62);
    ctx.lineTo(28, 52);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(16, 20, 32, 5);
    ctx.fillRect(16, 31, 22, 5);

    if (totalUnread > 0) {
      const badgeText = totalUnread > 99 ? '99+' : String(totalUnread);
      ctx.fillStyle = '#e53935';
      ctx.beginPath();
      ctx.arc(48, 18, 16, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 19px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, 48, 19);
    }

    const dataUrl = canvas.toDataURL('image/png');
    document.querySelectorAll("link[rel*='icon']").forEach(el => el.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = dataUrl;
    document.head.appendChild(link);
  }

  // --- 1. סנכרון מלא מול דף אנשי הקשר של השרת (/user/Contacts) ---
  function parseContactsFromDoc(doc) {
    const tbl = doc.getElementById('MainContent_GridViewContacts');
    const list = [];
    const map = {};
    if (!tbl) return { list, map };

    let dataRowIndex = 0;
    tbl.querySelectorAll('tbody > tr').forEach((row, idx) => {
      if (idx === 0) return;
      if (row.querySelector('table') || row.innerHTML.includes('Page$')) return;

      const cells = row.querySelectorAll(':scope > td');
      if (cells.length >= 4) {
        const name = cells[2].innerText.replace(/\u00a0/g, '').trim();
        const rawPhone = cells[3].innerText.replace(/\u00a0/g, '').trim();
        const email = cells[4] ? cells[4].innerText.replace(/\u00a0/g, '').trim() : '';
        const notes = cells[5] ? cells[5].innerText.replace(/\u00a0/g, '').trim() : '';
        const phone = normalizePhone(rawPhone);

        if (name || phone) {
          const item = { rowIndex: dataRowIndex, name, phone, rawPhone, email, notes };
          list.push(item);
          if (phone) map[phone] = item;
        }
        dataRowIndex++;
      }
    });

    return { list, map };
  }

  async function refreshContactsFromServer() {
    try {
      const resp = await fetch('/user/Contacts');
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const parsed = parseContactsFromDoc(doc);
      siteContacts = parsed.list;
      contactsByPhone = parsed.map;
      renderChatList();
      if (activeContact) {
        updateHeaderInfo();
        renderMessages(false);
      }
      return doc;
    } catch (e) {
      console.warn('שגיאה בטעינת אנשי קשר מהשרת:', e);
      return null;
    }
  }

  async function addContactToServer(name, phone, email = '', notes = '') {
    const resp = await fetch('/user/Contacts');
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const form = doc.querySelector('form');
    const formData = new FormData(form);

    formData.set('ctl00$MainContent$FormViewContacts$cNameTextBox', name);
    formData.set('ctl00$MainContent$FormViewContacts$cNumberTextBox', phone);
    formData.set('ctl00$MainContent$FormViewContacts$cEmailTextBox', email);
    formData.set('ctl00$MainContent$FormViewContacts$cNoteTextBox', notes);
    formData.set('__EVENTTARGET', 'ctl00$MainContent$FormViewContacts$InsertButton');
    formData.set('__EVENTARGUMENT', '');

    const postResp = await fetch('/user/Contacts', {
      method: 'POST',
      body: new URLSearchParams(formData)
    });
    const postHtml = await postResp.text();
    const postDoc = new DOMParser().parseFromString(postHtml, 'text/html');
    const parsed = parseContactsFromDoc(postDoc);
    siteContacts = parsed.list;
    contactsByPhone = parsed.map;
    renderChatList();
    if (activeContact) {
      updateHeaderInfo();
      renderMessages(false);
    }
  }

  async function updateContactOnServer(rowIndex, name, phone, email = '', notes = '') {
    const getResp = await fetch('/user/Contacts');
    const getHtml = await getResp.text();
    const doc1 = new DOMParser().parseFromString(getHtml, 'text/html');
    const formData1 = new FormData(doc1.querySelector('form'));
    formData1.set('__EVENTTARGET', 'ctl00$MainContent$GridViewContacts');
    formData1.set('__EVENTARGUMENT', `Edit$${rowIndex}`);

    const editResp = await fetch('/user/Contacts', {
      method: 'POST',
      body: new URLSearchParams(formData1)
    });
    const editHtml = await editResp.text();
    const doc2 = new DOMParser().parseFromString(editHtml, 'text/html');

    const tbl = doc2.getElementById('MainContent_GridViewContacts');
    const editInputs = tbl ? tbl.querySelectorAll('input[type="text"]') : [];
    const saveLink = tbl ? Array.from(tbl.querySelectorAll('a')).find(a => a.innerText.trim() === 'שמירה') : null;

    if (editInputs.length < 2 || !saveLink) {
      throw new Error('לא נמצאו שדות עריכה בטבלת השרת');
    }

    const saveMatch = saveLink.getAttribute('href').match(/__doPostBack\('([^']+)'/);
    const saveTarget = saveMatch ? saveMatch[1] : `ctl00$MainContent$GridViewContacts$ctl0${rowIndex + 2}$ctl00`;

    const formData2 = new FormData(doc2.querySelector('form'));
    formData2.set(editInputs[0].name, name);
    formData2.set(editInputs[1].name, phone);
    if (editInputs[2]) formData2.set(editInputs[2].name, email);
    if (editInputs[3]) formData2.set(editInputs[3].name, notes);
    formData2.set('__EVENTTARGET', saveTarget);
    formData2.set('__EVENTARGUMENT', '');

    const saveResp = await fetch('/user/Contacts', {
      method: 'POST',
      body: new URLSearchParams(formData2)
    });
    const saveHtml = await saveResp.text();
    const doc3 = new DOMParser().parseFromString(saveHtml, 'text/html');
    const parsed = parseContactsFromDoc(doc3);
    siteContacts = parsed.list;
    contactsByPhone = parsed.map;
    renderChatList();
    if (activeContact) {
      updateHeaderInfo();
      renderMessages(false);
    }
  }

  async function deleteContactFromServer(rowIndex) {
    const getResp = await fetch('/user/Contacts');
    const getHtml = await getResp.text();
    const doc1 = new DOMParser().parseFromString(getHtml, 'text/html');
    const formData = new FormData(doc1.querySelector('form'));
    formData.set('__EVENTTARGET', 'ctl00$MainContent$GridViewContacts');
    formData.set('__EVENTARGUMENT', `Delete$${rowIndex}`);

    const delResp = await fetch('/user/Contacts', {
      method: 'POST',
      body: new URLSearchParams(formData)
    });
    const delHtml = await delResp.text();
    const doc2 = new DOMParser().parseFromString(delHtml, 'text/html');
    const parsed = parseContactsFromDoc(doc2);
    siteContacts = parsed.list;
    contactsByPhone = parsed.map;
    renderChatList();
    if (activeContact) {
      updateHeaderInfo();
      renderMessages(false);
    }
  }

  // --- 2. חילוץ הודעות וטעינת היסטוריה ללא הגבלת בלוקים ---
  function extractCellTextWithLineBreaks(cell) {
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    return clone.textContent.replace(/\r\n/g, '\n').trim();
  }

  function parseMessagesFromDoc(doc) {
    const tbl = doc.getElementById('MainContent_GridView1');
    if (!tbl) return [];
    const msgs = [];

    tbl.querySelectorAll('tbody > tr').forEach((row, index) => {
      if (index === 0) return;
      if (row.querySelector('table') || row.innerHTML.includes('Page$')) return;

      const cells = row.querySelectorAll(':scope > td');
      if (cells.length >= 4) {
        const rawNum = cells[0].innerText.trim();
        const time = cells[1].innerText.trim();
        const text = extractCellTextWithLineBreaks(cells[2]);
        const directionRaw = cells[3].innerText.trim();
        const status = cells[4] ? cells[4].innerText.trim() : '';

        if (!rawNum || !time) return;

        const number = normalizePhone(rawNum);
        const isOutgoing = directionRaw.includes('יוצאת');
        const id = `${number}_${time}_${text.slice(0, 20)}`;
        msgs.push({ id, number, rawNum, time, text, isOutgoing, status, isOptimistic: false });
      }
    });

    return msgs;
  }

  function mergeMessages(newMsgs, isLivePoll = false) {
    const existingIds = new Set(allMessages.map(m => m.id));
    let changed = false;
    const newlyArrivedIncoming = [];

    newMsgs.forEach(m => {
      if (!m.isOptimistic && m.isOutgoing) {
        const optIdx = allMessages.findIndex(
          existing =>
            existing.isOptimistic &&
            existing.number === m.number &&
            existing.text.trim() === m.text.trim()
        );
        if (optIdx !== -1) {
          allMessages[optIdx] = m;
          existingIds.add(m.id);
          knownMessageIds.add(m.id);
          changed = true;
          return;
        }
      }

      if (!existingIds.has(m.id)) {
        allMessages.push(m);
        existingIds.add(m.id);
        changed = true;

        if (isLivePoll && !m.isOutgoing && !knownMessageIds.has(m.id)) {
          newlyArrivedIncoming.push(m);
        }
        knownMessageIds.add(m.id);
      }
    });

    if (newlyArrivedIncoming.length > 0) {
      newlyArrivedIncoming.forEach(m => {
        if (m.number !== activeContact || document.hidden) {
          unreadCounts[m.number] = (unreadCounts[m.number] || 0) + 1;
        }
      });
      saveUnreadStorage();

      const latest = newlyArrivedIncoming[0];
      const senderName = getDisplayName(latest.number);
      const cleanBody = cleanIncomingMessageBody(latest.text, latest.number, latest.rawNum);
      if (soundEnabled) playSelectedSound(selectedSoundType);
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`הודעת SMS חדשה מ-${senderName}`, { body: cleanBody });
      }
    }

    return changed;
  }

  function updateLoadMoreButtonUI() {
    const btn = document.getElementById('btn-load-more-history');
    if (!btn) return;
    if (noMoreHistoryPages) {
      btn.disabled = true;
      btn.innerText = `✓ כל ההיסטוריה נטענה (${highestLoadedPage} עמודים)`;
      btn.style.opacity = '0.65';
    } else if (isLoadingHistory) {
      btn.disabled = true;
      btn.innerText = `טוען עמוד ${highestLoadedPage + 1}...`;
    } else {
      btn.disabled = false;
      btn.innerText = `📜 טען היסטוריה נוספת (נטענו ${highestLoadedPage} עמ')`;
    }
  }

  async function loadMorePagesBatch(batchSize = 15) {
    if (isLoadingHistory || noMoreHistoryPages) return;
    const banner = document.getElementById('sms-loading-banner');
    const form = document.querySelector('form');
    if (!form) return;

    isLoadingHistory = true;
    updateLoadMoreButtonUI();

    let loadedInThisBatch = 0;

    while (loadedInThisBatch < batchSize) {
      const links = Array.from(historyDocState.querySelectorAll('a[href*="Page$"]'));
      const candidatePages = links
        .map(a => {
          const m = a.getAttribute('href').match(/Page\$(\d+)/);
          return m ? Number(m[1]) : null;
        })
        .filter(n => n !== null && n > highestLoadedPage)
        .sort((a, b) => a - b);

      if (candidatePages.length === 0) {
        noMoreHistoryPages = true;
        break;
      }

      const nextPageNum = candidatePages[0];
      const target = `Page$${nextPageNum}`;
      highestLoadedPage = nextPageNum;
      loadedInThisBatch++;

      banner.style.display = 'block';
      banner.innerText = `טוען היסטוריית הודעות (עמוד ${nextPageNum})...`;
      updateLoadMoreButtonUI();

      try {
        const formData = new FormData(form);
        const vs = historyDocState.getElementById('__VIEWSTATE')?.value;
        const vsg = historyDocState.getElementById('__VIEWSTATEGENERATOR')?.value;
        const ev = historyDocState.getElementById('__EVENTVALIDATION')?.value;
        if (vs) formData.set('__VIEWSTATE', vs);
        if (vsg) formData.set('__VIEWSTATEGENERATOR', vsg);
        if (ev) formData.set('__EVENTVALIDATION', ev);
        formData.set('__EVENTTARGET', 'ctl00$MainContent$GridView1');
        formData.set('__EVENTARGUMENT', target);

        const resp = await fetch(window.location.href, {
          method: 'POST',
          body: new URLSearchParams(formData)
        });
        const html = await resp.text();
        historyDocState = new DOMParser().parseFromString(html, 'text/html');

        const pageMsgs = parseMessagesFromDoc(historyDocState);
        if (mergeMessages(pageMsgs, false)) {
          renderChatList();
          if (activeContact) renderMessages(false);
        }
      } catch (e) {
        console.warn('עצירת טעינת עמודים:', e);
        break;
      }
    }

    banner.style.display = 'none';
    isLoadingHistory = false;
    updateLoadMoreButtonUI();
  }

  async function fetchBalance() {
    try {
      const resp = await fetch('/sms/Default');
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const bal = doc.getElementById('MainContent_LabelBalance')?.innerText.trim();
      if (bal) {
        document.getElementById('sms-balance-display').innerText = `יתרה: ${bal} הודעות`;
      }
    } catch (e) {}
  }

  // --- 3. בניית ממשק המשתמש ---
  document.body.classList.add('sms-modern-active');

  const app = document.createElement('div');
  app.id = 'sms-modern-app';
  app.innerHTML = `
    <div class="sms-sidebar" style="position: relative;">
      <div class="sms-sidebar-header">
        <div class="sms-sidebar-title-wrap">
          <h2>הודעות SMS</h2>
          <span class="sms-balance-badge" id="sms-balance-display">טוען יתרה...</span>
        </div>
        <div class="sms-header-actions">
          <button class="sms-icon-btn primary" id="btn-new-msg">+ חדשה</button>
          <button class="sms-icon-btn" id="btn-contacts-mgr">אנשי קשר</button>
          <button class="sms-icon-btn" id="btn-show-old" title="מעבר לאתר המקורי">מקור</button>
        </div>
      </div>

      <div class="sms-search-box">
        <input type="text" id="sms-search-input" placeholder="חיפוש שם, מספר או תוכן...">
        <button class="sms-icon-btn ${soundEnabled ? 'active-toggle' : ''}" id="btn-toggle-sound" title="הפעל/השתק התראות וצליל">🔔</button>
        <button class="sms-icon-btn" id="btn-sound-settings" title="בחירת צליל התראה">⚙️</button>
      </div>

      <div class="sms-sound-menu" id="sms-sound-menu">
        <strong style="font-size:12px; color:#54656f;">בחר צליל התראה:</strong>
        <div class="sms-sound-option" data-sound="double_bell"><span>🔔 פעמון כפול נעים</span><span>▶</span></div>
        <div class="sms-sound-option" data-sound="soft_chord"><span>🎵 אקורד רך</span><span>▶</span></div>
        <div class="sms-sound-option" data-sound="rising_chime"><span>✨ שלישיית צלילים</span><span>▶</span></div>
        <div class="sms-sound-option" data-sound="simple_beep"><span>📟 ביפ קצר</span><span>▶</span></div>
      </div>

      <div class="sms-filter-tabs">
        <button class="sms-filter-tab active" data-filter="all">הכל</button>
        <button class="sms-filter-tab" data-filter="incoming">נכנסות</button>
        <button class="sms-filter-tab" data-filter="outgoing">יוצאות</button>
        <button class="sms-filter-tab" data-filter="unanswered">ממתינות לתשובה</button>
      </div>

      <div class="sms-loading-banner" id="sms-loading-banner"></div>
      <div class="sms-chat-list" id="sms-chat-list"></div>
      <div style="padding: 8px; border-top: 1px solid #e9edef; background: #f8f9fa; text-align: center;">
        <button class="sms-icon-btn" id="btn-load-more-history" style="width: 100%; justify-content: center; font-weight: 600;">📜 טען היסטוריה נוספת</button>
      </div>
    </div>

    <div class="sms-main">
      <div class="sms-main-header">
        <div class="sms-main-contact-info" id="sms-header-contact-card" title="לחץ לפתיחת כרטיסיית איש קשר">
          <div class="sms-avatar" id="sms-header-avatar">?</div>
          <div>
            <div class="sms-main-title" id="sms-active-title">בחר שיחה</div>
            <div class="sms-main-subtitle" id="sms-active-subtitle">לחץ כאן לכרטיסיית איש קשר</div>
          </div>
        </div>
        <div class="sms-header-actions">
          <button class="sms-icon-btn" id="btn-pin-chat" title="הצמד שיחה לראש הרשימה">📌 הצמד</button>
          <button class="sms-icon-btn" id="btn-export-chat" title="ייצוא שיחה לקובץ CSV">📥 ייצוא</button>
          <button class="sms-icon-btn" id="btn-edit-contact-quick" title="כרטיסיית איש קשר">✏️ כרטיסייה</button>
        </div>
      </div>

      <div class="sms-messages-area" id="sms-messages-area"></div>

      <div class="sms-popover sms-emoji-picker" id="sms-emoji-picker"></div>
      <div class="sms-popover sms-templates-popover" id="sms-templates-popover"></div>

      <div class="sms-composer-wrap">
        <div class="sms-toolbar">
          <div class="sms-format-btns">
            <button class="sms-tool-btn" id="btn-emoji-toggle" type="button">😊 אימוג'י</button>
            <button class="sms-tool-btn" id="btn-templates-toggle" type="button">⚡ תבניות</button>
            <button class="sms-tool-btn" id="btn-bold" type="button" title="הדגשה"><b>B</b></button>
            <button class="sms-tool-btn" id="btn-italic" type="button" title="כתב נטוי"><i>I</i></button>
            <label style="margin-right: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
              <input type="checkbox" id="chk-hide-number"> מספר חסוי
            </label>
          </div>
          <span id="sms-char-counter">0 תווים (1 הודעה)</span>
        </div>
        <div class="sms-input-bar">
          <textarea id="sms-reply-input" placeholder="הקלד הודעה... (Enter לשליחה, Shift+Enter לשורה חדשה)"></textarea>
          <button class="sms-send-btn" id="sms-send-action">שלח</button>
        </div>
      </div>
    </div>

    <!-- חלון קופץ: הודעה חדשה -->
    <div class="sms-modal-backdrop" id="modal-new-msg">
      <div class="sms-modal">
        <div class="sms-modal-header">
          <h3>הודעה חדשה</h3>
          <button class="sms-modal-close" data-close="modal-new-msg">✕</button>
        </div>
        <div class="sms-modal-body">
          <div class="sms-field-group">
            <label>הזן מספר טלפון חדש (ללא איש קשר):</label>
            <div style="display:flex; gap:8px;">
              <input type="text" id="new-msg-phone" placeholder="לדוגמה: 0501234567" style="flex:1;">
              <button class="sms-icon-btn primary" id="btn-start-new-chat">פתח שיחה</button>
            </div>
          </div>
          <div class="sms-field-group">
            <label>או בחר מתוך אנשי הקשר שבחשבון:</label>
            <input type="text" id="new-msg-contact-search" placeholder="הקלד שם או מספר לחיפוש...">
          </div>
          <div id="new-msg-contacts-list" style="max-height: 250px; overflow-y: auto; border: 1px solid #e9edef; border-radius: 8px;"></div>
        </div>
      </div>
    </div>

    <!-- חלון קופץ: ניהול אנשי קשר וכרטיסייה (מסונכרן לשרת) -->
    <div class="sms-modal-backdrop" id="modal-contacts">
      <div class="sms-modal" style="width: 580px;">
        <div class="sms-modal-header">
          <h3>אנשי קשר (מסונכרן לחשבון באתר)</h3>
          <button class="sms-modal-close" data-close="modal-contacts">✕</button>
        </div>
        <div class="sms-modal-body">
          <div style="background: #f0f2f5; padding: 12px; border-radius: 8px; display: flex; flex-direction: column; gap: 8px;">
            <strong style="font-size: 13px;" id="contact-form-title">הוספת איש קשר חדש לאתר:</strong>
            <input type="hidden" id="edit-contact-row-index" value="">
            <div style="display: flex; gap: 8px;">
              <input type="text" id="edit-contact-name" placeholder="שם מלא *" style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #d1d7db;">
              <input type="text" id="edit-contact-phone" placeholder="מספר טלפון *" style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #d1d7db;">
            </div>
            <div style="display: flex; gap: 8px;">
              <input type="text" id="edit-contact-email" placeholder="דוא״ל (אופציונלי)" style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #d1d7db;">
              <input type="text" id="edit-contact-notes" placeholder="הערות (אופציונלי)" style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #d1d7db;">
            </div>
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
              <button class="sms-icon-btn" id="btn-reset-contact-form" style="display:none;">ביטול עריכה</button>
              <button class="sms-icon-btn primary" id="btn-save-contact">שמור בחשבון האתר</button>
            </div>
          </div>

          <input type="text" id="contacts-mgr-search" placeholder="חיפוש באנשי הקשר..." style="padding: 8px 12px; border-radius: 8px; border: 1px solid #d1d7db;">
          <div id="contacts-mgr-list" style="max-height: 280px; overflow-y: auto; border: 1px solid #e9edef; border-radius: 8px;"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(app);

  document.getElementById('btn-load-more-history').addEventListener('click', () => {
    loadMorePagesBatch(15);
  });

  // כפתור חזרה לעיצוב החדש
  const restoreBtn = document.createElement('button');
  restoreBtn.id = 'sms-restore-btn';
  restoreBtn.innerText = 'חזור לעיצוב הצ׳אט החדש';
  restoreBtn.style.display = 'none';
  document.body.appendChild(restoreBtn);

  document.getElementById('btn-show-old').addEventListener('click', () => {
    document.body.classList.remove('sms-modern-active');
    app.style.display = 'none';
    restoreBtn.style.display = 'block';
  });

  restoreBtn.addEventListener('click', () => {
    document.body.classList.add('sms-modern-active');
    app.style.display = 'flex';
    restoreBtn.style.display = 'none';
  });

  // --- 4. ניהול מעבר בין שיחות, טיוטות וסימון כנקרא ---
  const replyInput = document.getElementById('sms-reply-input');

  function updateCharCounter() {
    const len = replyInput.value.length;
    const parts = Math.max(1, Math.ceil(len / 160));
    document.getElementById('sms-char-counter').innerText = `${len} תווים (${parts} הודעות)`;
  }

  function markContactAsRead(contact) {
    if (contact && unreadCounts[contact]) {
      delete unreadCounts[contact];
      saveUnreadStorage();
    }
  }

  function switchActiveContact(newContact) {
    if (activeContact && activeContact !== newContact) {
      const currentText = replyInput.value;
      if (currentText.trim()) {
        draftsByContact[activeContact] = currentText;
      } else {
        delete draftsByContact[activeContact];
      }
      saveDraftsStorage();
    }

    activeContact = newContact;
    markContactAsRead(activeContact);
    replyInput.value = (activeContact && draftsByContact[activeContact]) ? draftsByContact[activeContact] : '';
    updateCharCounter();
    renderChatList();
    renderMessages(true);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeContact && unreadCounts[activeContact]) {
      markContactAsRead(activeContact);
      renderChatList();
    }
  });

  replyInput.addEventListener('input', () => {
    updateCharCounter();
    if (!activeContact) return;
    const hadDraft = Boolean(draftsByContact[activeContact]);
    const hasDraftNow = Boolean(replyInput.value.trim());

    if (hasDraftNow) {
      draftsByContact[activeContact] = replyInput.value;
    } else {
      delete draftsByContact[activeContact];
    }
    saveDraftsStorage();

    if (hadDraft !== hasDraftNow) {
      renderChatList();
    }
  });

  // --- 5. רינדור שיחות והודעות ---
  function parseHebrewDate(str) {
    const parts = str.split(' ');
    if (parts.length < 2) return 0;
    const [d, m, y] = parts[0].split('/').map(Number);
    const [hr, min, sec] = parts[1].split(':').map(Number);
    return new Date(y, m - 1, d, hr || 0, min || 0, sec || 0).getTime();
  }

  function getGroupedConversations() {
    const groups = {};
    allMessages.forEach(msg => {
      if (!groups[msg.number]) groups[msg.number] = [];
      groups[msg.number].push(msg);
    });
    if (activeContact && !groups[activeContact]) {
      groups[activeContact] = [];
    }
    Object.keys(groups).forEach(num => {
      groups[num].sort((a, b) => parseHebrewDate(a.time) - parseHebrewDate(b.time));
    });
    return groups;
  }

  function renderChatList() {
    const filter = document.getElementById('sms-search-input').value.toLowerCase();
    const listEl = document.getElementById('sms-chat-list');
    listEl.innerHTML = '';

    const groups = getGroupedConversations();
    const keys = Object.keys(groups).sort((a, b) => {
      const aPin = pinnedContacts.includes(a) ? 1 : 0;
      const bPin = pinnedContacts.includes(b) ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      const aLast = groups[a][groups[a].length - 1];
      const bLast = groups[b][groups[b].length - 1];
      return (bLast ? parseHebrewDate(bLast.time) : Date.now()) - (aLast ? parseHebrewDate(aLast.time) : Date.now());
    });

    if (!activeContact && keys.length > 0) {
      activeContact = keys[0];
      markContactAsRead(activeContact);
      replyInput.value = draftsByContact[activeContact] || '';
      updateCharCounter();
    }

    keys.forEach(contact => {
      const displayName = getDisplayName(contact);
      const msgs = groups[contact];
      const lastMsg = msgs[msgs.length - 1];
      const isUnanswered = lastMsg && !lastMsg.isOutgoing;
      const unreadNum = unreadCounts[contact] || 0;
      const draftText = draftsByContact[contact];

      if (activeFilterTab === 'incoming' && !msgs.some(m => !m.isOutgoing)) return;
      if (activeFilterTab === 'outgoing' && !msgs.some(m => m.isOutgoing)) return;
      if (activeFilterTab === 'unanswered' && !isUnanswered) return;

      const matchName = displayName.toLowerCase().includes(filter) || contact.includes(filter);
      const matchText = msgs.some(m => m.text.toLowerCase().includes(filter));
      if (!matchName && !matchText) return;

      const isPinned = pinnedContacts.includes(contact);
      let lastPreviewText = 'שיחה חדשה';
      if (lastMsg) {
        const cleanBody = lastMsg.isOutgoing
          ? lastMsg.text
          : cleanIncomingMessageBody(lastMsg.text, lastMsg.number, lastMsg.rawNum);
        lastPreviewText = (lastMsg.isOutgoing ? 'אתה: ' : '') + escapeHtml(cleanBody.replace(/\n/g, ' '));
      }

      const previewHtml = draftText
        ? `<span style="color:#008069; font-weight:600;">טיוטה:</span> ${escapeHtml(draftText.replace(/\n/g, ' '))}`
        : lastPreviewText;

      let rightBadgeHtml = '';
      if (unreadNum > 0) {
        rightBadgeHtml = `<span class="sms-unread-badge" title="${unreadNum} הודעות שלא נקראו">${unreadNum}</span>`;
      } else if (isUnanswered) {
        rightBadgeHtml = `<span class="sms-unanswered-dot" title="ממתינה לתשובה"></span>`;
      }

      const item = document.createElement('div');
      item.className = 'sms-chat-item'
        + (contact === activeContact ? ' active' : '')
        + (unreadNum > 0 ? ' unread' : '');

      item.innerHTML = `
        <div class="sms-avatar">${escapeHtml(displayName.slice(0, 2))}</div>
        <div class="sms-chat-info">
          <div class="sms-chat-item-top">
            <span class="sms-chat-name">${isPinned ? '📌 ' : ''}${escapeHtml(displayName)}</span>
            <span class="sms-chat-time">${lastMsg ? lastMsg.time.split(' ')[0] : 'חדש'}</span>
          </div>
          <div class="sms-chat-preview">
            <span style="overflow:hidden; text-overflow:ellipsis;">${previewHtml}</span>
            ${rightBadgeHtml}
          </div>
        </div>
      `;
      item.addEventListener('click', () => {
        switchActiveContact(contact);
      });
      listEl.appendChild(item);
    });
  }

  function updateHeaderInfo() {
    if (!activeContact) return;
    const c = contactsByPhone[activeContact];
    const name = c?.name || activeContact;
    document.getElementById('sms-active-title').innerText = name;
    document.getElementById('sms-header-avatar').innerText = name.slice(0, 2);

    const subParts = [];
    if (name !== activeContact) subParts.push(activeContact);
    else subParts.push('לא שמור באנשי קשר');
    if (c?.email) subParts.push(c.email);
    if (c?.notes) subParts.push(c.notes);
    document.getElementById('sms-active-subtitle').innerText = subParts.join(' • ');
  }

  function renderMessages(scrollToBottom = true) {
    const areaEl = document.getElementById('sms-messages-area');
    areaEl.innerHTML = '';

    if (!activeContact) {
      document.getElementById('sms-active-title').innerText = 'בחר שיחה';
      return;
    }

    updateHeaderInfo();
    const groups = getGroupedConversations();
    const msgs = groups[activeContact] || [];

    msgs.forEach(msg => {
      const bubble = document.createElement('div');
      bubble.className = 'sms-bubble ' + (msg.isOutgoing ? 'outgoing' : 'incoming');

      const displayBody = msg.isOutgoing
        ? msg.text.split('\n').map(l => l.trim()).join('\n').trim()
        : cleanIncomingMessageBody(msg.text, msg.number, msg.rawNum);

      const otpMatch = !msg.isOutgoing && displayBody.match(/\b\d{4,8}\b/);
      const otpHtml = otpMatch
        ? `<button class="sms-otp-btn" data-code="${otpMatch[0]}">העתק קוד ${otpMatch[0]}</button>`
        : '';

      const shortTime = msg.time.replace(/\/\d{4}\s/, ' ').replace(/:\d{2}$/, '');

      bubble.innerHTML = `
        <div class="sms-bubble-text">${formatMessageTextWithLinks(displayBody)}</div>
        <div class="sms-bubble-meta">
          <span title="${msg.time}">${shortTime}${msg.status && msg.status !== 'נשלח' ? ' • ' + msg.status : ''}</span>
          ${otpHtml}
        </div>
      `;
      areaEl.appendChild(bubble);
    });

    areaEl.querySelectorAll('.sms-otp-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.code);
        btn.innerText = 'הועתק!';
        setTimeout(() => (btn.innerText = `העתק קוד ${btn.dataset.code}`), 1500);
      });
    });

    if (scrollToBottom) {
      areaEl.scrollTop = areaEl.scrollHeight;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // --- 6. שליחת הודעה ישירה ---
  async function sendSmsDirect() {
    const btn = document.getElementById('sms-send-action');
    const text = replyInput.value.trim();
    if (!text || !activeContact) return;

    const targetContact = activeContact;
    const hideNumber = document.getElementById('chk-hide-number').checked;
    btn.disabled = true;
    btn.innerText = 'שולח...';

    try {
      const getResp = await fetch('/sms/Default');
      const getHtml = await getResp.text();
      const doc = new DOMParser().parseFromString(getHtml, 'text/html');
      const formData = new FormData(doc.querySelector('form'));

      formData.set('ctl00$MainContent$smsText', text);
      formData.set('ctl00$MainContent$smsNumbers', targetContact);
      if (hideNumber) {
        formData.set('ctl00$MainContent$CheckBoxHideMyNumber', 'on');
      } else {
        formData.delete('ctl00$MainContent$CheckBoxHideMyNumber');
      }
      formData.set('ctl00$MainContent$ButtonSendSms', 'שלח סמס');

      const postResp = await fetch('/sms/Default', {
        method: 'POST',
        body: new URLSearchParams(formData)
      });
      const postHtml = await postResp.text();
      const postDoc = new DOMParser().parseFromString(postHtml, 'text/html');
      const bal = postDoc.getElementById('MainContent_LabelBalance')?.innerText.trim();
      if (bal) {
        document.getElementById('sms-balance-display').innerText = `יתרה: ${bal} הודעות`;
      }

      const now = new Date();
      const timeStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      mergeMessages([{
        id: `opt_${targetContact}_${Date.now()}`,
        number: targetContact,
        rawNum: targetContact,
        time: timeStr,
        text,
        isOutgoing: true,
        status: 'נשלח',
        isOptimistic: true
      }], false);

      delete draftsByContact[targetContact];
      saveDraftsStorage();
      markContactAsRead(targetContact);

      if (activeContact === targetContact) {
        replyInput.value = '';
        updateCharCounter();
      }
      renderChatList();
      renderMessages(true);
    } catch (err) {
      alert('אירעה שגיאה בשליחת ההודעה. נסה שוב.');
    } finally {
      btn.disabled = false;
      btn.innerText = 'שלח';
    }
  }

  document.getElementById('sms-send-action').addEventListener('click', sendSmsDirect);
  replyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendSmsDirect();
    }
  });

  // --- 7. תבניות מהירות, אימוג'ים ועיצוב ---
  function wrapSelection(wrapper) {
    const start = replyInput.selectionStart;
    const end = replyInput.selectionEnd;
    const val = replyInput.value;
    const selected = val.substring(start, end) || 'טקסט';
    replyInput.value = val.substring(0, start) + wrapper + selected + wrapper + val.substring(end);
    replyInput.dispatchEvent(new Event('input'));
    replyInput.focus();
  }

  document.getElementById('btn-bold').addEventListener('click', () => wrapSelection('*'));
  document.getElementById('btn-italic').addEventListener('click', () => wrapSelection('_'));

  const emojis = ['😊', '👍', '🙏', '❤️', '😂', '👌', '✅', '📞', '📅', '⏰', '🚗', '🏠', '💼', '📄', '🎉', '👏', '🤝', '💡', '⚡', '❗', '❓', '✨', '🌟', '👋'];
  const emojiPicker = document.getElementById('sms-emoji-picker');
  emojis.forEach(em => {
    const span = document.createElement('span');
    span.className = 'sms-emoji-item';
    span.innerText = em;
    span.addEventListener('click', () => {
      replyInput.value += em;
      replyInput.dispatchEvent(new Event('input'));
      replyInput.focus();
    });
    emojiPicker.appendChild(span);
  });

  const templatesPopover = document.getElementById('sms-templates-popover');
  function renderTemplatesPopover() {
    templatesPopover.innerHTML = '<strong style="font-size:12px; color:#54656f;">בחר תבנית להכנסה:</strong>';
    quickTemplates.forEach((tpl, idx) => {
      const div = document.createElement('div');
      div.className = 'sms-template-item';
      div.innerHTML = `<span>${escapeHtml(tpl)}</span><span style="color:#d93025; font-size:11px; padding:0 4px;" title="מחק תבנית">✕</span>`;
      div.firstChild.addEventListener('click', () => {
        replyInput.value += (replyInput.value ? ' ' : '') + tpl;
        templatesPopover.classList.remove('open');
        replyInput.dispatchEvent(new Event('input'));
        replyInput.focus();
      });
      div.lastChild.addEventListener('click', (e) => {
        e.stopPropagation();
        quickTemplates.splice(idx, 1);
        localStorage.setItem('sms_quick_templates', JSON.stringify(quickTemplates));
        renderTemplatesPopover();
      });
      templatesPopover.appendChild(div);
    });

    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex; gap:4px; margin-top:4px;';
    addRow.innerHTML = `<input type="text" id="new-tpl-input" placeholder="הוסף תבנית חדשה..." style="flex:1; padding:5px 8px; border:1px solid #d1d7db; border-radius:6px; font-size:12px;"><button class="sms-icon-btn primary" style="padding:4px 8px;">+</button>`;
    addRow.querySelector('button').addEventListener('click', () => {
      const val = addRow.querySelector('input').value.trim();
      if (!val) return;
      quickTemplates.push(val);
      localStorage.setItem('sms_quick_templates', JSON.stringify(quickTemplates));
      renderTemplatesPopover();
    });
    templatesPopover.appendChild(addRow);
  }

  document.getElementById('btn-emoji-toggle').addEventListener('click', () => {
    templatesPopover.classList.remove('open');
    emojiPicker.classList.toggle('open');
  });

  document.getElementById('btn-templates-toggle').addEventListener('click', () => {
    emojiPicker.classList.remove('open');
    renderTemplatesPopover();
    templatesPopover.classList.toggle('open');
  });

  // --- 8. הצמדת שיחה, ייצוא שיחה ולשוניות סינון ---
  document.getElementById('btn-pin-chat').addEventListener('click', () => {
    if (!activeContact) return;
    if (pinnedContacts.includes(activeContact)) {
      pinnedContacts = pinnedContacts.filter(c => c !== activeContact);
    } else {
      pinnedContacts.push(activeContact);
    }
    localStorage.setItem('sms_pinned_contacts', JSON.stringify(pinnedContacts));
    renderChatList();
  });

  function sanitizeCsvCell(val) {
    let str = String(val || '').replace(/"/g, '""');
    if (/^[=+\-@]/.test(str)) {
      str = "'" + str;
    }
    return `"${str}"`;
  }

  document.getElementById('btn-export-chat').addEventListener('click', () => {
    if (!activeContact) return;
    const groups = getGroupedConversations();
    const msgs = groups[activeContact] || [];
    const name = getDisplayName(activeContact);

    let csv = '\uFEFFתאריך ושעה,כיוון,מספר,שם,תוכן הודעה,סטטוס\n';
    msgs.forEach(m => {
      const dir = m.isOutgoing ? 'יוצאת' : 'נכנסת';
      const cleanBody = m.isOutgoing ? m.text : cleanIncomingMessageBody(m.text, m.number, m.rawNum);
      csv += `${sanitizeCsvCell(m.time)},${sanitizeCsvCell(dir)},${sanitizeCsvCell(activeContact)},${sanitizeCsvCell(name)},${sanitizeCsvCell(cleanBody)},${sanitizeCsvCell(m.status)}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SMS_${name}_${activeContact}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.querySelectorAll('.sms-filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sms-filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilterTab = tab.dataset.filter;
      renderChatList();
    });
  });

  // --- 9. חלונות ניהול אנשי קשר והודעה חדשה ---
  document.querySelectorAll('.sms-modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.close).classList.remove('open');
    });
  });

  document.getElementById('btn-new-msg').addEventListener('click', () => {
    document.getElementById('new-msg-phone').value = '';
    document.getElementById('new-msg-contact-search').value = '';
    renderNewMsgContacts('');
    document.getElementById('modal-new-msg').classList.add('open');
  });

  function renderNewMsgContacts(filter) {
    const container = document.getElementById('new-msg-contacts-list');
    container.innerHTML = '';
    siteContacts.forEach(c => {
      if (filter && !c.name.toLowerCase().includes(filter.toLowerCase()) && !c.phone.includes(filter)) return;
      const row = document.createElement('div');
      row.className = 'sms-contact-row';
      row.style.cursor = 'pointer';
      row.innerHTML = `<span><strong>${escapeHtml(c.name)}</strong></span><span style="color:#667781;">${c.phone}</span>`;
      row.addEventListener('click', () => {
        document.getElementById('modal-new-msg').classList.remove('open');
        switchActiveContact(c.phone);
        replyInput.focus();
      });
      container.appendChild(row);
    });
  }

  document.getElementById('new-msg-contact-search').addEventListener('input', (e) => {
    renderNewMsgContacts(e.target.value);
  });

  document.getElementById('btn-start-new-chat').addEventListener('click', () => {
    const num = normalizePhone(document.getElementById('new-msg-phone').value.trim());
    if (!num) return;
    document.getElementById('modal-new-msg').classList.remove('open');
    switchActiveContact(num);
    replyInput.focus();
  });

  function resetContactForm(prefillPhone = '') {
    const norm = normalizePhone(prefillPhone);
    const existing = norm ? contactsByPhone[norm] : null;
    document.getElementById('edit-contact-row-index').value = existing ? existing.rowIndex : '';
    document.getElementById('edit-contact-name').value = existing ? existing.name : '';
    document.getElementById('edit-contact-phone').value = norm;
    document.getElementById('edit-contact-email').value = existing ? existing.email : '';
    document.getElementById('edit-contact-notes').value = existing ? existing.notes : '';
    document.getElementById('contact-form-title').innerText = existing
      ? `עריכת כרטיסיית איש קשר (${existing.name}):`
      : 'הוספת איש קשר חדש לחשבון האתר:';
    document.getElementById('btn-reset-contact-form').style.display = existing ? 'inline-flex' : 'none';
  }

  function openContactsModal(prefillPhone = '') {
    resetContactForm(prefillPhone);
    renderContactsManagerList('');
    document.getElementById('modal-contacts').classList.add('open');
  }

  document.getElementById('btn-contacts-mgr').addEventListener('click', () => openContactsModal(''));
  document.getElementById('btn-edit-contact-quick').addEventListener('click', () => openContactsModal(activeContact || ''));
  document.getElementById('sms-header-contact-card').addEventListener('click', () => openContactsModal(activeContact || ''));
  document.getElementById('btn-reset-contact-form').addEventListener('click', () => resetContactForm(''));

  document.getElementById('btn-save-contact').addEventListener('click', async (e) => {
    const btn = e.target;
    const rowIdx = document.getElementById('edit-contact-row-index').value;
    const name = document.getElementById('edit-contact-name').value.trim();
    const phone = normalizePhone(document.getElementById('edit-contact-phone').value.trim());
    const email = document.getElementById('edit-contact-email').value.trim();
    const notes = document.getElementById('edit-contact-notes').value.trim();

    if (!name || !phone) {
      alert('חובה להזין שם ומספר טלפון.');
      return;
    }

    btn.disabled = true;
    btn.innerText = 'שומר בשרת...';
    try {
      if (rowIdx !== '') {
        await updateContactOnServer(Number(rowIdx), name, phone, email, notes);
      } else {
        await addContactToServer(name, phone, email, notes);
      }
      resetContactForm('');
      renderContactsManagerList(document.getElementById('contacts-mgr-search').value);
    } catch (err) {
      alert('אירעה שגיאה בשמירת איש הקשר בשרת האתר.');
    } finally {
      btn.disabled = false;
      btn.innerText = 'שמור בחשבון האתר';
    }
  });

  function renderContactsManagerList(filter) {
    const listEl = document.getElementById('contacts-mgr-list');
    listEl.innerHTML = '';
    siteContacts.forEach(c => {
      if (filter && !c.name.toLowerCase().includes(filter.toLowerCase()) && !c.phone.includes(filter)) return;
      const row = document.createElement('div');
      row.className = 'sms-contact-row';
      row.innerHTML = `
        <div style="min-width:0; flex:1;">
          <div><strong>${escapeHtml(c.name)}</strong> <span style="color:#667781; font-size:13px;">(${c.phone})</span></div>
          <div style="font-size:12px; color:#54656f;">${[c.email, c.notes].filter(Boolean).map(escapeHtml).join(' • ')}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button class="sms-icon-btn btn-msg-c">הודעה</button>
          <button class="sms-icon-btn btn-edit-c">ערוך</button>
          <button class="sms-icon-btn danger btn-del-c">מחק</button>
        </div>
      `;
      row.querySelector('.btn-msg-c').addEventListener('click', () => {
        document.getElementById('modal-contacts').classList.remove('open');
        switchActiveContact(c.phone);
      });
      row.querySelector('.btn-edit-c').addEventListener('click', () => {
        resetContactForm(c.phone);
      });
      row.querySelector('.btn-del-c').addEventListener('click', async () => {
        if (!confirm(`האם למחוק את "${c.name}" מחשבון האתר לצמיתות?`)) return;
        await deleteContactFromServer(c.rowIndex);
        renderContactsManagerList(document.getElementById('contacts-mgr-search').value);
      });
      listEl.appendChild(row);
    });
  }

  document.getElementById('contacts-mgr-search').addEventListener('input', (e) => {
    renderContactsManagerList(e.target.value);
  });

  document.getElementById('sms-search-input').addEventListener('input', renderChatList);

  // --- 10. מנוע הצלילים ובחירת צליל התראה ---
  function playSelectedSound(type = selectedSoundType) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;

      const playTone = (freq, startOffset, duration, wave = 'sine', peakGain = 0.18) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = wave;
        osc.frequency.setValueAtTime(freq, now + startOffset);
        gain.gain.setValueAtTime(0.001, now + startOffset);
        gain.gain.exponentialRampToValueAtTime(peakGain, now + startOffset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + startOffset);
        osc.stop(now + startOffset + duration);
      };

      if (type === 'double_bell') {
        playTone(880, 0, 0.22, 'sine', 0.2);
        playTone(1174.66, 0.16, 0.35, 'sine', 0.22);
      } else if (type === 'soft_chord') {
        playTone(523.25, 0, 0.45, 'triangle', 0.16);
        playTone(659.25, 0.05, 0.45, 'triangle', 0.14);
        playTone(783.99, 0.1, 0.5, 'triangle', 0.14);
      } else if (type === 'rising_chime') {
        playTone(587.33, 0, 0.18, 'sine', 0.18);
        playTone(739.99, 0.13, 0.18, 'sine', 0.18);
        playTone(880, 0.26, 0.32, 'sine', 0.2);
      } else {
        playTone(880, 0, 0.3, 'sine', 0.16);
      }
    } catch (e) {}
  }

  const soundMenu = document.getElementById('sms-sound-menu');
  function updateSoundMenuSelection() {
    soundMenu.querySelectorAll('.sms-sound-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.sound === selectedSoundType);
    });
  }
  updateSoundMenuSelection();

  document.getElementById('btn-sound-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    soundMenu.classList.toggle('open');
  });

  soundMenu.querySelectorAll('.sms-sound-option').forEach(opt => {
    opt.addEventListener('click', () => {
      selectedSoundType = opt.dataset.sound;
      localStorage.setItem('sms_sound_type', selectedSoundType);
      updateSoundMenuSelection();
      playSelectedSound(selectedSoundType);
    });
  });

  document.addEventListener('click', (e) => {
    if (!soundMenu.contains(e.target) && e.target.id !== 'btn-sound-settings') {
      soundMenu.classList.remove('open');
    }
  });

  document.getElementById('btn-toggle-sound').addEventListener('click', async (e) => {
    soundEnabled = !soundEnabled;
    localStorage.setItem('sms_sound_enabled', soundEnabled);
    e.target.classList.toggle('active-toggle', soundEnabled);

    if (soundEnabled) {
      playSelectedSound(selectedSoundType);
      if ('Notification' in window && Notification.permission !== 'granted') {
        await Notification.requestPermission();
      }
    }
  });

  // בדיקה שקטה ברקע כל 7 שניות
  setInterval(async () => {
    try {
      const resp = await fetch(window.location.href);
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const freshMsgs = parseMessagesFromDoc(doc);
      if (freshMsgs.length === 0) return;

      if (mergeMessages(freshMsgs, true)) {
        renderChatList();
        if (activeContact) renderMessages(true);
      }
    } catch (e) {}
  }, 7000);

  // --- אתחול ראשוני ---
  const initialMsgs = parseMessagesFromDoc(document);
  mergeMessages(initialMsgs, false);
  updateTabIconAndTitle();
  renderChatList();
  renderMessages(true);

  refreshContactsFromServer();
  fetchBalance();
  loadMorePagesBatch(15);

  // --- 11. מחיקה פיזית של בועת הצ'אט התחתונה (Tawk) וכל רכיב חיצוני אחר ---
  const purgeFloatingWidgets = () => {
    if (!document.body.classList.contains('sms-modern-active')) return;
    document.querySelectorAll('body > div, body > iframe').forEach(el => {
      if (el.id !== 'sms-modern-app' && el.id !== 'sms-restore-btn') {
        el.remove();
      }
    });
  };
  purgeFloatingWidgets();
  const widgetObserver = new MutationObserver(purgeFloatingWidgets);
  widgetObserver.observe(document.body, { childList: true });
})();
