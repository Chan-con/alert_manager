const { ipcRenderer } = require('electron');

let alerts = [];

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    await loadAlerts();
    setDefaultDateTime();
    updateTimeline();
    
    // 1分ごとにタイムラインを更新
    setInterval(updateTimeline, 60000);
    
    // メインプロセスからの削除通知を受信
    ipcRenderer.on('alert-deleted', (event, id) => {
        alerts = alerts.filter(alert => alert.id !== id);
        updateTimeline();
    });
    
    // メインプロセスからの更新通知を受信（繰り返し通知用）
    ipcRenderer.on('alert-updated', (event, updatedAlert) => {
        const index = alerts.findIndex(alert => alert.id === updatedAlert.id);
        if (index !== -1) {
            alerts[index] = updatedAlert;
            updateTimeline();
        }
    });
    
    // URL入力フィールドの変更を監視
    const urlInput = document.getElementById('alert-url');
    const addBtn = document.querySelector('.add-btn-compact');
    
    urlInput.addEventListener('input', () => {
        validateFormInputs();
        updateUrlInputStyle();
    });
    
    // 他の必須フィールドも監視
    document.getElementById('alert-content').addEventListener('input', validateFormInputs);
    document.getElementById('alert-date').addEventListener('change', validateFormInputs);
    document.getElementById('alert-time').addEventListener('change', validateFormInputs);
    
    // 初期バリデーション
    validateFormInputs();
});

// デフォルトの日時を設定
function setDefaultDateTime() {
    const now = new Date();
    // 現在の日付を取得（ローカルタイムゾーン）
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const date = `${year}-${month}-${day}`;
    
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const time = `${hours}:${minutes}`;
    
    document.getElementById('alert-date').value = date;
    document.getElementById('alert-time').value = time;
}

// アラートを読み込み
async function loadAlerts() {
    try {
        alerts = await ipcRenderer.invoke('get-alerts');
        console.log('アラートを読み込みました:', alerts.length);
    } catch (error) {
        console.error('アラートの読み込みエラー:', error);
    }
}

// 新しいアラートを追加
async function addAlert() {
    const content = document.getElementById('alert-content').value.trim();
    const date = document.getElementById('alert-date').value;
    const time = document.getElementById('alert-time').value;
    const url = document.getElementById('alert-url').value.trim();
    const reminderMinutes = parseInt(document.getElementById('reminder-minutes').value);
    const repeatType = document.getElementById('repeat-type').value;
    
    if (!content || !date || !time) {
        showCuteAlert('通知内容、日付、時間を入力してください。', 'error');
        return false;
    }
    
    // 曜日指定の場合は選択された曜日をチェック
    let selectedWeekdays = [];
    if (repeatType === 'weekdays') {
        selectedWeekdays = getSelectedWeekdays();
        if (selectedWeekdays.length === 0) {
            showCuteAlert('曜日を選択してください。', 'error');
            return false;
        }
    }
    
    // 日付指定の場合は選択された日付をチェック
    let selectedDates = [];
    if (repeatType === 'monthly-dates') {
        selectedDates = getSelectedDates();
        if (selectedDates.length === 0) {
            showCuteAlert('日付を選択してください。', 'error');
            return false;
        }
    }
    
    const dateTime = new Date(`${date}T${time}`);
    
    if (dateTime <= new Date()) {
        showCuteAlert('未来の日時を選択してください。', 'error');
        return false;
    }
    
    const newAlert = {
        content: content,
        dateTime: dateTime.toISOString(),
        url: url || null,
        reminderMinutes: reminderMinutes > 0 ? reminderMinutes : null,
        repeatType: repeatType || 'none',
        weekdays: selectedWeekdays.length > 0 ? selectedWeekdays : null,
        dates: selectedDates.length > 0 ? selectedDates : null,
        createdAt: new Date().toISOString()
    };
    
    try {
        const savedAlert = await ipcRenderer.invoke('add-alert', newAlert);
        alerts.push(savedAlert);
        
        // フォームをリセット
        document.getElementById('alert-content').value = '';
        document.getElementById('alert-url').value = '';
        document.getElementById('reminder-minutes').value = '0';
        document.getElementById('repeat-type').value = 'none';
        toggleRepeatOptions();
        setDefaultDateTime();
        
        updateTimeline();
        
        console.log('アラートを追加しました:', savedAlert);
        return true;
    } catch (error) {
        console.error('アラート追加エラー:', error);
        showCuteAlert('アラートの追加に失敗しました。', 'error');
        return false;
    }
}

// アラートを削除
async function deleteAlert(id) {
    const confirmed = await showCuteConfirmDialog('この通知を削除しますか？', '削除すると元に戻すことはできません。');
    if (!confirmed) {
        return;
    }
    
    try {
        await ipcRenderer.invoke('delete-alert', id);
        alerts = alerts.filter(alert => alert.id !== id);
        updateTimeline();
        
        console.log('アラートを削除しました:', id);
    } catch (error) {
        console.error('アラート削除エラー:', error);
        showCuteAlert('アラートの削除に失敗しました。', 'error');
    }
}

// アラートを編集
async function editAlert(id) {
    const alert = alerts.find(a => a.id === id);
    if (!alert) return;
    
    // 編集フォームを表示
    showEditForm(alert);
}

// 編集フォームを表示
function showEditForm(alert) {
    const editModal = document.createElement('div');
    editModal.className = 'edit-modal';
    
    const alertDateTime = new Date(alert.dateTime);
    const date = alertDateTime.toISOString().split('T')[0];
    const time = alertDateTime.toTimeString().split(' ')[0].substring(0, 5);
    
    editModal.innerHTML = `
        <div class="edit-modal-content">
            <h3>通知を編集</h3>
            <div class="edit-form">
                <div class="form-group">
                    <label>通知内容</label>
                    <input type="text" id="edit-content" value="${alert.content}" class="edit-input">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>日付</label>
                        <input type="date" id="edit-date" value="${date}" class="edit-input">
                    </div>
                    <div class="form-group">
                        <label>時間</label>
                        <input type="time" id="edit-time" value="${time}" class="edit-input">
                    </div>
                </div>
                <div class="form-group">
                    <label>URL</label>
                    <input type="url" id="edit-url" value="${alert.url || ''}" class="edit-input">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>事前通知</label>
                        <select id="edit-reminder" class="edit-input">
                            <option value="0" ${!alert.reminderMinutes ? 'selected' : ''}>なし</option>
                            <option value="1" ${alert.reminderMinutes === 1 ? 'selected' : ''}>1分前</option>
                            <option value="3" ${alert.reminderMinutes === 3 ? 'selected' : ''}>3分前</option>
                            <option value="5" ${alert.reminderMinutes === 5 ? 'selected' : ''}>5分前</option>
                            <option value="10" ${alert.reminderMinutes === 10 ? 'selected' : ''}>10分前</option>
                            <option value="15" ${alert.reminderMinutes === 15 ? 'selected' : ''}>15分前</option>
                            <option value="30" ${alert.reminderMinutes === 30 ? 'selected' : ''}>30分前</option>
                            <option value="60" ${alert.reminderMinutes === 60 ? 'selected' : ''}>1時間前</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>繰り返し</label>
                        <select id="edit-repeat" class="edit-input">
                            <option value="none" ${alert.repeatType === 'none' ? 'selected' : ''}>なし</option>
                            <option value="daily" ${alert.repeatType === 'daily' ? 'selected' : ''}>毎日</option>
                            <option value="weekly" ${alert.repeatType === 'weekly' ? 'selected' : ''}>毎週</option>
                            <option value="monthly" ${alert.repeatType === 'monthly' ? 'selected' : ''}>毎月</option>
                        </select>
                    </div>
                </div>
                <div class="edit-buttons">
                    <button onclick="saveEdit('${alert.id}')" class="save-btn">保存</button>
                    <button onclick="closeEditModal()" class="cancel-btn">キャンセル</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(editModal);
}

// 編集を保存
async function saveEdit(id) {
    const content = document.getElementById('edit-content').value.trim();
    const date = document.getElementById('edit-date').value;
    const time = document.getElementById('edit-time').value;
    const url = document.getElementById('edit-url').value.trim();
    const reminderMinutes = parseInt(document.getElementById('edit-reminder').value);
    const repeatType = document.getElementById('edit-repeat').value;
    
    if (!content || !date || !time) {
        showCuteAlert('通知内容、日付、時間を入力してください。', 'error');
        return;
    }
    
    const dateTime = new Date(`${date}T${time}`);
    
    if (dateTime <= new Date()) {
        showCuteAlert('未来の日時を選択してください。', 'error');
        return;
    }
    
    const updatedAlert = {
        content: content,
        dateTime: dateTime.toISOString(),
        url: url || null,
        reminderMinutes: reminderMinutes > 0 ? reminderMinutes : null,
        repeatType: repeatType || 'none'
    };
    
    try {
        const savedAlert = await ipcRenderer.invoke('edit-alert', id, updatedAlert);
        if (savedAlert) {
            const index = alerts.findIndex(alert => alert.id === id);
            if (index !== -1) {
                alerts[index] = savedAlert;
                updateTimeline();
                closeEditModal();
                console.log('アラートを更新しました:', savedAlert);
            }
        }
    } catch (error) {
        console.error('アラート更新エラー:', error);
        showCuteAlert('アラートの更新に失敗しました。', 'error');
    }
}

// 編集モーダルを閉じる
function closeEditModal() {
    const modal = document.querySelector('.edit-modal');
    if (modal) {
        modal.remove();
    }
}

// タイムラインを更新
function updateTimeline() {
    const timeline = document.getElementById('timeline');
    
    if (alerts.length === 0) {
        timeline.innerHTML = '<div class="empty-timeline">まだ通知がありません<br>新しい通知を追加してみましょう！</div>';
        return;
    }
    
    const now = new Date();
    
    // 有効なアラートのみを表示（期限切れは繰り返しアラートのみ残す）
    const activeAlerts = alerts.filter(alert => {
        const alertTime = new Date(alert.dateTime);
        // 未来のアラートまたは繰り返しアラートのみ表示
        return alertTime > now || (alert.repeatType && alert.repeatType !== 'none');
    });
    
    if (activeAlerts.length === 0) {
        timeline.innerHTML = '<div class="empty-timeline">有効な通知がありません<br>新しい通知を追加してみましょう！</div>';
        return;
    }
    
    // 日時順にソート（早い順）
    const sortedAlerts = [...activeAlerts].sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
    
    timeline.innerHTML = sortedAlerts.map(alert => {
        const alertTime = new Date(alert.dateTime);
        const isPast = alertTime < now;
        const isSoon = !isPast && (alertTime.getTime() - now.getTime()) < 60 * 60 * 1000; // 1時間以内
        
        const timeString = formatDateTime(alertTime);
        const contentWithLinks = processLinks(alert.content);
        
        let statusClass = '';
        if (isPast) statusClass = 'past';
        else if (isSoon) statusClass = 'soon';
        
        return `
            <div class="timeline-item ${statusClass}">
                <div class="alert-card">
                    <div class="alert-header">
                        <div class="alert-time">${timeString}</div>
                        <div class="alert-actions">
                            ${alert.repeatType && alert.repeatType !== 'none' ? `<button class="skip-btn" onclick="skipAlert('${alert.id}')" title="この回をスキップ">⏭️</button>` : ''}
                            <button class="edit-btn" onclick="editAlert('${alert.id}')" title="編集">✏️</button>
                            <button class="delete-btn" onclick="deleteAlert('${alert.id}')" title="削除">×</button>
                        </div>
                    </div>
                    <div class="alert-content">${contentWithLinks}</div>
                    ${alert.url ? `<div class="alert-url"><span class="url-icon">🔗</span><a href="#" onclick="openLink('${alert.url}')" title="${alert.url}">${alert.url}</a></div>` : ''}
                    <div class="alert-details">
                        ${alert.reminderMinutes ? `<span class="alert-reminder">📢 ${alert.reminderMinutes}分前にお知らせ</span>` : ''}
                        ${alert.repeatType && alert.repeatType !== 'none' ? `<span class="alert-repeat">🔄 ${getRepeatText(alert.repeatType, alert.weekdays, alert.dates)}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// 日時をフォーマット
function formatDateTime(date) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const alertDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    // 曜日名の配列
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const dayOfWeek = dayNames[date.getDay()];
    
    let dateStr = '';
    if (alertDate.getTime() === today.getTime()) {
        dateStr = '今日';
    } else {
        const month = date.getMonth() + 1;
        const day = date.getDate();
        dateStr = `${month}/${day}(${dayOfWeek})`;
    }
    
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    
    return `${dateStr} ${hours}:${minutes}`;
}

// 繰り返しタイプのテキストを取得
function getRepeatText(repeatType, weekdays, dates) {
    switch (repeatType) {
        case 'daily': return '毎日';
        case 'weekly': return '毎週';
        case 'weekdays': {
            if (!weekdays || weekdays.length === 0) return '曜日指定';
            const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
            return weekdays.map(day => dayNames[day]).join('・');
        }
        case 'monthly': return '毎月';
        case 'monthly-dates': {
            if (!dates || dates.length === 0) return '毎月（日付指定）';
            return '毎月 ' + dates.join('・') + '日';
        }
        default: return '';
    }
}

// リンクを処理
function processLinks(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, (url) => {
        return `<a href="#" onclick="openLink('${url}')">${url}</a>`;
    });
}

// リンクを新しいウィンドウで開く
window.openLink = async function(url) {
    try {
        console.log('🔗 openLink関数が呼び出されました:', url);
        const result = await ipcRenderer.invoke('open-link', url);
        console.log('🔗 open-link結果:', result);
    } catch (error) {
        console.error('🔗 リンクオープンエラー:', error);
    }
}

// ウィンドウ制御
async function minimizeWindow() {
    try {
        await ipcRenderer.invoke('minimize-window');
    } catch (error) {
        console.error('ウィンドウ最小化エラー:', error);
    }
}

async function closeWindow() {
    try {
        await ipcRenderer.invoke('close-window');
    } catch (error) {
        console.error('ウィンドウクローズエラー:', error);
    }
}


// キーボードショートカット
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        addAlert();
    }
    
    // ESCキーでウインドウを閉じる機能を無効化
    // if (e.key === 'Escape') {
    //     closeWindow();
    // }
});

// フォームトグル機能
let formExpanded = false;

function toggleForm() {
    const formContent = document.getElementById('form-content');
    const toggleBtn = document.querySelector('.toggle-btn');
    
    formExpanded = !formExpanded;
    
    if (formExpanded) {
        formContent.classList.add('active');
        toggleBtn.classList.add('active');
        toggleBtn.querySelector('.toggle-text').textContent = '閉じる';
        // フォームを開いた時に現在の日付と時刻を設定
        setDefaultDateTime();
        
        // フォームのスクロール位置を一番上に戻す
        setTimeout(() => {
            formContent.scrollTop = 0;
        }, 50); // アニメーション後にスクロール
    } else {
        formContent.classList.remove('active');
        toggleBtn.classList.remove('active');
        toggleBtn.querySelector('.toggle-text').textContent = '新しい通知';
    }
}

// フォーム入力の妥当性をチェック
function validateFormInputs() {
    const content = document.getElementById('alert-content').value.trim();
    const date = document.getElementById('alert-date').value;
    const time = document.getElementById('alert-time').value;
    const url = document.getElementById('alert-url').value.trim();
    const addBtn = document.querySelector('.add-btn-compact');
    
    // 必須フィールドのチェック
    const hasRequiredFields = content && date && time;
    
    // URLが入力されている場合は、有効性をチェック
    let isUrlValid = true;
    if (url) {
        try {
            new URL(url);
        } catch (e) {
            isUrlValid = false;
        }
    }
    
    // ボタンの有効/無効を切り替え
    if (hasRequiredFields && isUrlValid) {
        addBtn.disabled = false;
        addBtn.style.opacity = '1';
        addBtn.style.cursor = 'pointer';
    } else {
        addBtn.disabled = true;
        addBtn.style.opacity = '0.5';
        addBtn.style.cursor = 'not-allowed';
    }
}

// URL入力フィールドの見た目を更新
function updateUrlInputStyle() {
    const urlInput = document.getElementById('alert-url');
    const url = urlInput.value.trim();
    
    if (url) {
        try {
            new URL(url);
            // 有効なURL
            urlInput.style.borderColor = '#4CAF50';
            urlInput.style.boxShadow = '0 0 0 2px rgba(76, 175, 80, 0.2)';
        } catch (e) {
            // 無効なURL
            urlInput.style.borderColor = '#ff6b6b';
            urlInput.style.boxShadow = '0 0 0 2px rgba(255, 107, 107, 0.2)';
        }
    } else {
        // 空の場合はデフォルト
        urlInput.style.borderColor = '#e8f4ff';
        urlInput.style.boxShadow = 'none';
    }
}

// かわいい確認ダイアログを表示
function showCuteConfirmDialog(title, message) {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'cute-dialog-overlay';
        
        dialog.innerHTML = `
            <div class="cute-dialog">
                <div class="cute-dialog-header">
                    <span class="cute-dialog-emoji">🌸</span>
                    <h3 class="cute-dialog-title">${title}</h3>
                </div>
                <div class="cute-dialog-content">
                    <p class="cute-dialog-message">${message}</p>
                </div>
                <div class="cute-dialog-buttons">
                    <button class="cute-btn cute-btn-secondary" onclick="handleCuteDialogResponse(false)">
                        <span>キャンセル</span>
                    </button>
                    <button class="cute-btn cute-btn-primary" onclick="handleCuteDialogResponse(true)">
                        <span>削除する</span>
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        // アニメーション
        setTimeout(() => {
            dialog.classList.add('show');
        }, 10);
        
        // グローバルハンドラーを設定
        window.handleCuteDialogResponse = (result) => {
            dialog.classList.remove('show');
            setTimeout(() => {
                document.body.removeChild(dialog);
                delete window.handleCuteDialogResponse;
                resolve(result);
            }, 300);
        };
    });
}

// かわいいアラートダイアログを表示
function showCuteAlert(message, type = 'info') {
    const dialog = document.createElement('div');
    dialog.className = 'cute-dialog-overlay';
    
    const emoji = type === 'error' ? '😿' : '🌟';
    const titleText = type === 'error' ? 'エラー' : 'お知らせ';
    
    dialog.innerHTML = `
        <div class="cute-dialog">
            <div class="cute-dialog-header">
                <span class="cute-dialog-emoji">${emoji}</span>
                <h3 class="cute-dialog-title">${titleText}</h3>
            </div>
            <div class="cute-dialog-content">
                <p class="cute-dialog-message">${message}</p>
            </div>
            <div class="cute-dialog-buttons">
                <button class="cute-btn cute-btn-primary" onclick="closeCuteAlert()">
                    <span>OK</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(dialog);
    
    // アニメーション
    setTimeout(() => {
        dialog.classList.add('show');
    }, 10);
    
    // グローバルハンドラーを設定
    window.closeCuteAlert = () => {
        dialog.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(dialog);
            delete window.closeCuteAlert;
        }, 300);
    };
}

// 既存のaddAlert関数を保存
const originalAddAlert = addAlert;

// addAlert関数を再定義してフォームトグル機能を追加
window.addAlert = async function() {
    const result = await originalAddAlert();
    if (result !== false && formExpanded) {
        toggleForm();
    }
    return result;
};

// 繰り返しオプションの表示/非表示を切り替え
function toggleRepeatOptions() {
    const repeatType = document.getElementById('repeat-type').value;
    const weekdayOptions = document.getElementById('weekday-options');
    const dateOptions = document.getElementById('date-options');
    
    // 曜日選択の表示制御
    if (repeatType === 'weekdays') {
        weekdayOptions.style.display = 'block';
    } else {
        weekdayOptions.style.display = 'none';
        resetWeekdayOptions();
    }
    
    // 日付選択の表示制御
    if (repeatType === 'monthly-dates') {
        dateOptions.style.display = 'block';
    } else {
        dateOptions.style.display = 'none';
        resetDateOptions();
    }
}

// 曜日選択の表示/非表示を切り替え（後方互換性のため）
function toggleWeekdayOptions() {
    toggleRepeatOptions();
}

// 曜日選択をリセット
function resetWeekdayOptions() {
    const weekdayBtns = document.querySelectorAll('#weekday-options .weekday-btn');
    weekdayBtns.forEach(btn => {
        btn.classList.remove('active');
    });
}

// 選択された曜日を取得
function getSelectedWeekdays() {
    const weekdayBtns = document.querySelectorAll('#weekday-options .weekday-btn.active');
    return Array.from(weekdayBtns).map(btn => parseInt(btn.dataset.day));
}

// 日付選択をリセット
function resetDateOptions() {
    const dateBtns = document.querySelectorAll('#date-options .date-btn');
    dateBtns.forEach(btn => {
        btn.classList.remove('active');
    });
}

// 選択された日付を取得
function getSelectedDates() {
    const dateBtns = document.querySelectorAll('#date-options .date-btn.active');
    return Array.from(dateBtns).map(btn => parseInt(btn.dataset.date));
}

// アラートをスキップ
async function skipAlert(id) {
    const confirmed = await showCuteConfirmDialog('この通知をスキップしますか？', 'この回の通知をスキップして次回の予定に進みます。');
    if (!confirmed) {
        return;
    }
    
    try {
        await ipcRenderer.invoke('skip-alert', id);
        await loadAlerts();
        updateTimeline();
        
        console.log('アラートをスキップしました:', id);
    } catch (error) {
        console.error('アラートスキップエラー:', error);
        showCuteAlert('アラートのスキップに失敗しました。', 'error');
    }
}

// DOM読み込み後に曜日・日付ボタンのイベントリスナーを設定
document.addEventListener('DOMContentLoaded', function() {
    // 曜日ボタンのクリックイベント
    const weekdayBtns = document.querySelectorAll('#weekday-options .weekday-btn');
    weekdayBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
        });
    });
    
    // 日付ボタンのクリックイベント
    const dateBtns = document.querySelectorAll('#date-options .date-btn');
    dateBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
        });
    });
    
    // 設定を読み込み
    loadSettingsFromStorage();
    
    // ホットキー入力のクリックイベントを設定
    const hotkeyInput = document.getElementById('timeline-hotkey');
    hotkeyInput.addEventListener('click', captureHotkey);
});

// 設定ウィンドウ関連の変数
let currentSettings = {
    timelineHotkey: null,
    autoStartEnabled: false
};

let isCapturingHotkey = false;

// 設定ウィンドウを開く
async function openSettings() {
    // キャプチャ中の場合は停止
    if (isCapturingHotkey) {
        await stopHotkeyCapture();
    }
    
    const settingsModal = document.getElementById('settings-modal');
    settingsModal.classList.add('show');
    
    // メインプロセスに設定ウィンドウが開いたことを通知
    try {
        await ipcRenderer.invoke('settings-window-opened');
    } catch (error) {
        console.error('設定ウィンドウ開放通知エラー:', error);
    }
    
    // 現在の設定を表示
    updateSettingsDisplay();
}

// 設定ウィンドウを閉じる
async function closeSettings() {
    const settingsModal = document.getElementById('settings-modal');
    settingsModal.classList.remove('show');
    
    // キャプチャ中の場合は停止
    if (isCapturingHotkey) {
        await stopHotkeyCapture();
    }
    
    // メインプロセスに設定ウィンドウが閉じたことを通知
    try {
        await ipcRenderer.invoke('settings-window-closed');
    } catch (error) {
        console.error('設定ウィンドウ閉鎖通知エラー:', error);
    }
}

// 設定表示を更新
function updateSettingsDisplay() {
    const hotkeyInput = document.getElementById('timeline-hotkey');
    const autoStartCheckbox = document.getElementById('auto-start-checkbox');
    
    if (currentSettings.timelineHotkey) {
        hotkeyInput.value = formatHotkey(currentSettings.timelineHotkey);
    } else {
        hotkeyInput.value = '';
    }
    
    autoStartCheckbox.checked = currentSettings.autoStartEnabled || false;
}

// ホットキーをフォーマット
function formatHotkey(hotkey) {
    if (!hotkey) return '';
    
    const parts = [];
    if (hotkey.ctrl) parts.push('Ctrl');
    if (hotkey.alt) parts.push('Alt');
    if (hotkey.shift) parts.push('Shift');
    if (hotkey.key) parts.push(hotkey.key.toUpperCase());
    
    return parts.join(' + ');
}

// ホットキーキャプチャを開始
async function captureHotkey() {
    console.log('=== ホットキーキャプチャ開始 ===');
    const hotkeyInput = document.getElementById('timeline-hotkey');
    
    if (isCapturingHotkey) {
        console.log('既にキャプチャ中です - 停止します');
        stopHotkeyCapture();
        return;
    }
    
    isCapturingHotkey = true;
    hotkeyInput.classList.add('capturing');
    hotkeyInput.value = 'キーを押してください... (ESC でキャンセル)';
    hotkeyInput.focus();
    
    console.log('キャプチャ状態を開始に設定:', isCapturingHotkey);
    
    // メインプロセスにキャプチャ開始を通知（既存のグローバルショートカットを一時的に無効化）
    try {
        await ipcRenderer.invoke('hotkey-capture-started');
        console.log('メインプロセスにキャプチャ開始を通知しました');
    } catch (error) {
        console.error('ホットキーキャプチャ開始通知エラー:', error);
    }
    
    // キーボードイベントリスナーを追加
    document.addEventListener('keydown', handleHotkeyCapture);
    document.addEventListener('keyup', handleHotkeyKeyUp);
    console.log('キーボードイベントリスナーを追加しました');
}

// ホットキーキャプチャを停止
async function stopHotkeyCapture() {
    const hotkeyInput = document.getElementById('timeline-hotkey');
    
    isCapturingHotkey = false;
    hotkeyInput.classList.remove('capturing');
    hotkeyInput.blur();
    
    // メインプロセスにキャプチャ停止を通知
    try {
        await ipcRenderer.invoke('hotkey-capture-stopped');
    } catch (error) {
        console.error('ホットキーキャプチャ停止通知エラー:', error);
    }
    
    document.removeEventListener('keydown', handleHotkeyCapture);
    document.removeEventListener('keyup', handleHotkeyKeyUp);
    updateSettingsDisplay();
}

// ホットキーキャプチャハンドラー
async function handleHotkeyCapture(event) {
    console.log('=== キーイベント発火 ===');
    console.log('キー:', event.key);
    console.log('修飾キー - Ctrl:', event.ctrlKey, 'Alt:', event.altKey, 'Shift:', event.shiftKey);
    
    event.preventDefault();
    
    const hotkeyInput = document.getElementById('timeline-hotkey');
    
    // ESCキーでキャンセル
    if (event.key === 'Escape') {
        console.log('ESCキーが押されました - キャプチャを停止');
        await stopHotkeyCapture();
        return;
    }
    
    // 修飾キーのみの場合は、現在の組み合わせを表示するが登録はしない
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
        console.log('修飾キーのみが押されました:', event.key);
        // 現在押されている修飾キーを表示
        const parts = [];
        if (event.ctrlKey) parts.push('Ctrl');
        if (event.altKey) parts.push('Alt');
        if (event.shiftKey) parts.push('Shift');
        if (parts.length > 0) {
            hotkeyInput.value = parts.join(' + ') + ' + ?';
            console.log('表示更新:', hotkeyInput.value);
        }
        return;
    }
    
    console.log('通常のキーが押されました - ホットキーとして処理します');
    
    // ホットキーを作成
    const hotkey = {
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        key: event.key
    };
    
    console.log('キャプチャされたホットキー:', hotkey);
    console.log('現在の設定:', currentSettings.timelineHotkey);
    
    // 既存のホットキーと同じかチェック
    const isSameHotkey = currentSettings.timelineHotkey && 
                        currentSettings.timelineHotkey.ctrl === hotkey.ctrl &&
                        currentSettings.timelineHotkey.alt === hotkey.alt &&
                        currentSettings.timelineHotkey.shift === hotkey.shift &&
                        currentSettings.timelineHotkey.key === hotkey.key;
    
    console.log('同じホットキーか:', isSameHotkey);
    
    if (isSameHotkey) {
        // 既存のホットキーと同じ場合
        hotkeyInput.value = formatHotkey(hotkey) + ' ✓ すでに登録済みのキーです';
        hotkeyInput.style.color = '#4CAF50';
        hotkeyInput.style.fontWeight = 'bold';
        
        // 2秒後に通常の表示に戻す
        setTimeout(() => {
            hotkeyInput.value = formatHotkey(hotkey);
            hotkeyInput.style.color = '#333';
            hotkeyInput.style.fontWeight = 'normal';
        }, 2000);
    } else {
        // 新しいホットキーの場合
        currentSettings.timelineHotkey = hotkey;
        hotkeyInput.value = formatHotkey(hotkey) + ' ✨ 新しく設定されました';
        hotkeyInput.style.color = '#ff9ff3';
        hotkeyInput.style.fontWeight = 'bold';
        
        // 2秒後に通常の表示に戻す
        setTimeout(() => {
            hotkeyInput.value = formatHotkey(hotkey);
            hotkeyInput.style.color = '#333';
            hotkeyInput.style.fontWeight = 'normal';
        }, 2000);
    }
    
    await stopHotkeyCapture();
}

// ホットキーキャプチャ中のキーアップハンドラー
function handleHotkeyKeyUp(event) {
    // 修飾キーが離された場合は表示を更新
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
        const hotkeyInput = document.getElementById('timeline-hotkey');
        
        // 現在押されている修飾キーを取得
        const parts = [];
        if (event.ctrlKey && event.key !== 'Control') parts.push('Ctrl');
        if (event.altKey && event.key !== 'Alt') parts.push('Alt');
        if (event.shiftKey && event.key !== 'Shift') parts.push('Shift');
        
        if (parts.length > 0) {
            hotkeyInput.value = parts.join(' + ') + ' + ?';
        } else {
            hotkeyInput.value = 'キーを押してください... (ESC でキャンセル)';
        }
    }
}

// 設定を保存
async function saveSettings() {
    try {
        // 自動起動設定を取得
        const autoStartCheckbox = document.getElementById('auto-start-checkbox');
        currentSettings.autoStartEnabled = autoStartCheckbox.checked;
        
        const result = await ipcRenderer.invoke('save-settings', currentSettings);
        if (result.success) {
            // グローバルホットキーを更新
            updateGlobalHotkeys();
            
            showCuteAlert('設定を保存しました。', 'info');
            
            // 設定ウィンドウを閉じる前に通知
            await closeSettings();
        } else {
            showCuteAlert('設定の保存に失敗しました。', 'error');
        }
    } catch (error) {
        console.error('設定の保存に失敗しました:', error);
        showCuteAlert('設定の保存に失敗しました。', 'error');
    }
}

// ストレージから設定を読み込み
async function loadSettingsFromStorage() {
    try {
        console.log('=== 設定を読み込み中 ===');
        const result = await ipcRenderer.invoke('load-settings');
        console.log('設定読み込み結果:', result);
        if (result.success) {
            currentSettings = result.settings;
            console.log('現在の設定:', currentSettings);
            updateGlobalHotkeys();
        }
    } catch (error) {
        console.error('設定の読み込みに失敗しました:', error);
    }
}

// グローバルホットキーを更新（メインプロセスで処理されるため、何もしない）
function updateGlobalHotkeys() {
    // メインプロセスでグローバルショートカットが処理されるため、
    // レンダラープロセスでは何も行わない
}

// タイムラインウィンドウの表示/非表示をトグル
async function toggleTimelineWindow() {
    try {
        await ipcRenderer.invoke('toggle-window');
    } catch (error) {
        console.error('ウィンドウトグルエラー:', error);
    }
}

