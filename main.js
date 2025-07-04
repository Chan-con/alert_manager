const { app, BrowserWindow, ipcMain, shell, Notification, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

let mainWindow;
let alerts = [];
let tray = null;

// 二重起動を防止
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 二重起動された場合は既存のウィンドウを表示
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 750,
    frame: false, // ヘッダーレス
    transparent: true, // 透明背景
    alwaysOnTop: false, // 常に最前面を無効化
    resizable: true,
    minWidth: 350,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    }
  });

  mainWindow.loadFile('index.html');
  
  // 開発時のみDevToolsを開く
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // ウィンドウが閉じられたときの処理（タスクトレイに格納）
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 右上の位置にウィンドウを配置
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  mainWindow.setPosition(width - 420, 20);

  // タスクトレイを作成
  createTray();
}

function createTray() {
  // アイコンファイルのパス
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  
  // アイコンファイルが存在しない場合はElectronのデフォルトアイコンを使用
  try {
    if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath);
    } else {
      // プラットフォームごとにフォールバック
      tray = new Tray('');
    }
  } catch (error) {
    tray = new Tray('');
  }
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '表示',
      click: () => {
        mainWindow.show();
      }
    },
    {
      label: '非表示',
      click: () => {
        mainWindow.hide();
      }
    },
    {
      type: 'separator'
    },
    {
      label: '終了',
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('通知タイムライン');
  tray.setContextMenu(contextMenu);
  
  // トレイアイコンをクリックしたときの処理
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });
}

// アプリが準備完了したときの処理
app.whenReady().then(createWindow);

// 全てのウィンドウが閉じられたときの処理
app.on('window-all-closed', () => {
  // タスクトレイがあるので完全終了しない
  // if (process.platform !== 'darwin') {
  //   app.quit();
  // }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC通信の設定
ipcMain.handle('get-alerts', () => {
  return alerts;
});

ipcMain.handle('add-alert', (event, alert) => {
  alert.id = Date.now().toString();
  alerts.push(alert);
  saveAlerts();
  scheduleNotification(alert);
  return alert;
});

ipcMain.handle('edit-alert', (event, id, updatedAlert) => {
  const index = alerts.findIndex(alert => alert.id === id);
  if (index !== -1) {
    alerts[index] = { ...alerts[index], ...updatedAlert };
    saveAlerts();
    scheduleNotification(alerts[index]);
    return alerts[index];
  }
  return null;
});

ipcMain.handle('delete-alert', (event, id) => {
  alerts = alerts.filter(alert => alert.id !== id);
  saveAlerts();
  return true;
});

ipcMain.handle('open-link', (event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('minimize-window', () => {
  mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  mainWindow.close();
});

// アラートの保存と読み込み
function saveAlerts() {
  const alertsPath = path.join(__dirname, 'alerts.json');
  fs.writeFileSync(alertsPath, JSON.stringify(alerts, null, 2));
}

function loadAlerts() {
  const alertsPath = path.join(__dirname, 'alerts.json');
  if (fs.existsSync(alertsPath)) {
    const data = fs.readFileSync(alertsPath, 'utf8');
    alerts = JSON.parse(data);
    // 既存のアラートのスケジュールを再設定
    alerts.forEach(alert => {
      if (new Date(alert.dateTime) > new Date()) {
        scheduleNotification(alert);
      }
    });
  }
}

// 通知のスケジュール
function scheduleNotification(alert) {
  const alertTime = new Date(alert.dateTime);
  const now = new Date();
  
  if (alertTime > now) {
    const delay = alertTime.getTime() - now.getTime();
    setTimeout(() => {
      // 通知を表示
      new Notification({
        title: '通知',
        body: alert.content,
        icon: path.join(__dirname, 'assets', 'icon.png')
      }).show();
      
      // n分前通知の設定がない場合は、本番通知時にURLを開く
      if (alert.url && (!alert.reminderMinutes || alert.reminderMinutes === 0)) {
        shell.openExternal(alert.url);
      }
      
      // 繰り返し設定がある場合は次の通知をスケジュール
      if (alert.repeatType && alert.repeatType !== 'none') {
        scheduleNextRepeat(alert);
      }
      
      // 繰り返しなしの場合は終了後に自動削除
      if (!alert.repeatType || alert.repeatType === 'none') {
        setTimeout(() => {
          deleteExpiredAlert(alert.id);
        }, 5000); // 5秒後に削除
      }
    }, delay);
  }
  
  // n分前の通知
  if (alert.reminderMinutes && alert.reminderMinutes > 0) {
    const reminderTime = new Date(alertTime.getTime() - (alert.reminderMinutes * 60000));
    if (reminderTime > now) {
      const reminderDelay = reminderTime.getTime() - now.getTime();
      setTimeout(() => {
        new Notification({
          title: `${alert.reminderMinutes}分前のお知らせ`,
          body: alert.content,
          icon: path.join(__dirname, 'assets', 'icon.png')
        }).show();
        
        // n分前通知が設定されている場合は、この時にURLを開く
        if (alert.url) {
          shell.openExternal(alert.url);
        }
      }, reminderDelay);
    }
  }
}

// 繰り返し通知の次回スケジュール
function scheduleNextRepeat(alert) {
  const currentTime = new Date(alert.dateTime);
  let nextTime = new Date(currentTime);
  
  switch (alert.repeatType) {
    case 'daily':
      nextTime.setDate(nextTime.getDate() + 1);
      break;
    case 'weekly':
      nextTime.setDate(nextTime.getDate() + 7);
      break;
    case 'monthly':
      nextTime.setMonth(nextTime.getMonth() + 1);
      break;
    default:
      return;
  }
  
  // 新しい時間で通知を更新
  const updatedAlert = {
    ...alert,
    dateTime: nextTime.toISOString()
  };
  
  const index = alerts.findIndex(a => a.id === alert.id);
  if (index !== -1) {
    alerts[index] = updatedAlert;
    saveAlerts();
    scheduleNotification(updatedAlert);
    // レンダラープロセスに更新を通知
    if (mainWindow) {
      mainWindow.webContents.send('alert-updated', updatedAlert);
    }
  }
}

// 期限切れの通知を削除
function deleteExpiredAlert(id) {
  alerts = alerts.filter(alert => alert.id !== id);
  saveAlerts();
  // レンダラープロセスに削除を通知
  if (mainWindow) {
    mainWindow.webContents.send('alert-deleted', id);
  }
}

// アプリ起動時にアラートを読み込み
loadAlerts();