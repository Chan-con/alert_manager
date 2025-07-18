const { app, BrowserWindow, ipcMain, shell, Notification, Tray, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const express = require('express');
const { spawn } = require('child_process');
const os = require('os');

let mainWindow;
let alerts = [];
let tray = null;
let autoStartEnabled = false;
let expressApp;
let serverPort = 3000;
let alertTimers = new Map(); // アラートのタイマーIDを管理
let globalSettings = {
  timelineHotkey: null
};

let currentGlobalShortcut = null;
let isSettingsWindowOpen = false;
let isCapturingHotkey = false;

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
    show: false, // 起動時はウィンドウを非表示
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
  
  updateTrayMenu();
  
  tray.setToolTip('通知タイムライン');
  
  // トレイアイコンをクリックしたときの処理
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '終了',
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

// 自動起動の設定を管理する関数
function toggleAutoStart() {
  // セキュリティ強化: 自動起動を強制的に無効化
  autoStartEnabled = false;
  
  // 自動起動設定を更新
  app.setLoginItemSettings({
    openAtLogin: false,  // 強制的にfalseに設定
    openAsHidden: true
  });
  
  console.log('自動起動設定を無効化しました:', autoStartEnabled);
  
  saveSettings();
  updateTrayMenu();
}

// 現在の自動起動状態を取得（設定を上書きしない）
function getAutoStartStatus() {
  const loginItemSettings = app.getLoginItemSettings();
  return loginItemSettings.openAtLogin;
}

// 設定を保存
function saveSettings() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  const settings = {
    autoStartEnabled: autoStartEnabled,
    timelineHotkey: globalSettings.timelineHotkey || null
  };
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log('設定を保存しました:', settings);
  } catch (error) {
    console.error('設定の保存に失敗しました:', error);
  }
}

// 設定を読み込み
function loadSettings() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  
  // 現在のシステム設定を取得
  const systemAutoStart = getAutoStartStatus();
  
  if (fs.existsSync(settingsPath)) {
    try {
      const data = fs.readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(data);
      
      // 設定ファイルに autoStartEnabled が明示的に設定されている場合はそれを使用
      // 設定されていない場合は現在のシステム設定を使用
      autoStartEnabled = settings.autoStartEnabled !== undefined ? settings.autoStartEnabled : systemAutoStart;
      globalSettings.timelineHotkey = settings.timelineHotkey || null;
      
      console.log('設定ファイルから読み込み:', {
        autoStartEnabled,
        timelineHotkey: globalSettings.timelineHotkey
      });
    } catch (error) {
      console.error('設定読み込みエラー:', error);
      autoStartEnabled = systemAutoStart; // エラー時は現在のシステム設定を使用
      globalSettings.timelineHotkey = null;
    }
  } else {
    // 設定ファイルが存在しない場合は現在のシステム設定を使用
    autoStartEnabled = systemAutoStart;
    globalSettings.timelineHotkey = null;
    console.log('設定ファイルが存在しないため、システム設定を使用:', autoStartEnabled);
  }
  
  console.log('システムの自動起動状態:', systemAutoStart);
  console.log('最終的な自動起動状態:', autoStartEnabled);
  
  // 設定ファイルの値を優先し、必要に応じてシステム設定を同期
  if (autoStartEnabled !== systemAutoStart) {
    console.log('設定ファイルとシステム設定が異なるため、システム設定を更新します');
    
    // セキュリティ強化: 自動起動を強制的に無効化
    autoStartEnabled = false;
    console.log('セキュリティのため自動起動を強制的に無効化します');
    
    // 自動起動設定を更新
    app.setLoginItemSettings({
      openAtLogin: false,  // 強制的にfalseに設定
      openAsHidden: true
    });
  }
  
  // グローバルショートカットを設定
  updateGlobalShortcut();
}

// ホットキーをElectronのAccelerator形式に変換
function convertToAccelerator(hotkey) {
  if (!hotkey) return null;
  
  const parts = [];
  if (hotkey.ctrl) parts.push('CommandOrControl');
  if (hotkey.alt) parts.push('Alt');
  if (hotkey.shift) parts.push('Shift');
  
  // キーを適切な形式に変換
  let key = hotkey.key;
  
  // 特殊キーの変換
  const keyMap = {
    ' ': 'Space',
    'Enter': 'Return',
    'Escape': 'Escape',
    'Tab': 'Tab',
    'Backspace': 'BackSpace',
    'Delete': 'Delete',
    'Insert': 'Insert',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
    'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
    'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12'
  };
  
  if (keyMap[key]) {
    key = keyMap[key];
  } else if (key.length === 1) {
    key = key.toUpperCase();
  }
  
  parts.push(key);
  
  return parts.join('+');
}

// グローバルショートカットを更新
function updateGlobalShortcut() {
  // 既存のショートカットを解除
  if (currentGlobalShortcut) {
    try {
      globalShortcut.unregister(currentGlobalShortcut);
      console.log('既存のグローバルショートカットを解除しました:', currentGlobalShortcut);
    } catch (error) {
      console.error('グローバルショートカットの解除に失敗しました:', error);
    }
    currentGlobalShortcut = null;
  }
  
  // 新しいショートカットを登録
  if (globalSettings.timelineHotkey) {
    const accelerator = convertToAccelerator(globalSettings.timelineHotkey);
    if (accelerator) {
      try {
        const success = globalShortcut.register(accelerator, () => {
          console.log('グローバルホットキーが押されました:', accelerator);
          
          // 設定ウィンドウが開いている場合やキャプチャ中の場合は無視
          if (isSettingsWindowOpen || isCapturingHotkey) {
            console.log('設定ウィンドウが開いているかキャプチャ中のため、ホットキーを無視します');
            return;
          }
          
          if (mainWindow) {
            if (mainWindow.isVisible()) {
              mainWindow.hide();
            } else {
              mainWindow.show();
              mainWindow.focus();
            }
          }
        });
        
        if (success) {
          currentGlobalShortcut = accelerator;
          console.log('グローバルショートカットを登録しました:', accelerator);
        } else {
          console.error('グローバルショートカットの登録に失敗しました:', accelerator);
        }
      } catch (error) {
        console.error('グローバルショートカット登録エラー:', error);
      }
    }
  }
}

// Expressサーバーを起動
function startExpressServer() {
  expressApp = express();
  expressApp.use(express.json());
  
  // CORS設定
  expressApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  
  // 新規ウィンドウでURLを開くAPI
  expressApp.post('/api/open-url', async (req, res) => {
    const { url } = req.body;
    
    try {
      const platform = os.platform();
      console.log(`Platform: ${platform}`);
      
      // 専用プロファイルディレクトリを作成
      const userDataDir = path.join(os.homedir(), '.alerts-timeline-chrome-profile');
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
        console.log(`Created profile directory: ${userDataDir}`);
      }
      
      // メインウィンドウの位置を取得
      let windowPosition = '100,100';
      if (mainWindow) {
        const bounds = mainWindow.getBounds();
        windowPosition = `${bounds.x + 50},${bounds.y + 50}`;
      }
      
      const chromeArgs = [
        '--new-window',
        '--no-default-browser-check',
        '--no-first-run', 
        '--disable-default-apps',
        `--user-data-dir=${userDataDir}`,
        `--window-position=${windowPosition}`,
        '--window-size=1200,800',
        url
      ];
      
      if (platform === 'win32') {
        // Windows用 - 複数のChromeパスを試行
        const chromePaths = [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
        ];
        
        let chromeFound = false;
        for (const chromePath of chromePaths) {
          if (fs.existsSync(chromePath)) {
            console.log(`Chromeを起動: ${chromePath}`);
            spawn(chromePath, chromeArgs, { 
              detached: true, 
              stdio: 'ignore' 
            });
            chromeFound = true;
            break;
          }
        }
        
        if (!chromeFound) {
          console.log('デフォルトブラウザで開く');
          spawn('cmd', ['/c', 'start', '', url], { 
            detached: true, 
            stdio: 'ignore' 
          });
        }
        
      } else if (platform === 'darwin') {
        // macOS用
        console.log('macOS用のブラウザ起動');
        spawn('open', ['-n', '-a', 'Google Chrome', '--args', ...chromeArgs], { 
          detached: true, 
          stdio: 'ignore' 
        });
        
      }
      
      console.log('新規ブラウザウィンドウを開きました');
      res.json({ success: true });
      
    } catch (error) {
      console.error('Error opening browser:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // 利用可能なポートを見つけて起動
  const server = expressApp.listen(serverPort, () => {
    console.log(`Express server started on port ${serverPort}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      serverPort++;
      console.log(`Port ${serverPort - 1} is busy, trying ${serverPort}`);
      server.listen(serverPort);
    } else {
      console.error('Express server error:', err);
    }
  });
}

// アプリが準備完了したときの処理
app.whenReady().then(() => {
  // セキュリティ強化: 起動時に自動起動設定を強制的に無効化
  app.setLoginItemSettings({
    openAtLogin: false,
    openAsHidden: true
  });
  console.log('起動時に自動起動設定を無効化しました');
  
  loadSettings();
  loadAlerts(); // アラートデータを先に読み込む
  startExpressServer(); // Expressサーバーを起動
  createWindow();
  
});

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

// アプリ終了時にデータを保存
app.on('before-quit', () => {
  saveAlerts();
  saveSettings();
});

// アプリ終了時にグローバルショートカットを解除
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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
  clearAlertTimers(id);
  alerts = alerts.filter(alert => alert.id !== id);
  saveAlerts();
  return true;
});

ipcMain.handle('open-link', async (event, url) => {
  console.log('新規ブラウザウィンドウを開きます:', url);
  
  const platform = os.platform();
  console.log(`Platform: ${platform}`);
  
  // 専用プロファイルディレクトリを作成
  const userDataDir = path.join(os.homedir(), '.alerts-timeline-chrome-profile');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    console.log(`Created profile directory: ${userDataDir}`);
  }
  
  // 画面の中央にウィンドウを配置
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  
  const windowWidth = 1200;
  const windowHeight = 800;
  const centerX = Math.round((screenWidth - windowWidth) / 2);
  const centerY = Math.round((screenHeight - windowHeight) / 2);
  
  const windowPosition = `${centerX},${centerY}`;
  
  const chromeArgs = [
    '--new-window',
    '--no-default-browser-check',
    '--no-first-run', 
    '--disable-default-apps',
    `--user-data-dir=${userDataDir}`,
    `--window-position=${windowPosition}`,
    '--window-size=1200,800',
    url
  ];
  
  try {
    if (platform === 'win32') {
      // Windows用 - 複数のChromeパスを試行
      const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
      ];
      
      let chromeFound = false;
      for (const chromePath of chromePaths) {
        if (fs.existsSync(chromePath)) {
          console.log(`Chrome起動: ${chromePath}`);
          
          const child = spawn(chromePath, chromeArgs, { 
            detached: true, 
            stdio: 'ignore' 
          });
          child.unref();
          
          chromeFound = true;
          break;
        }
      }
      
      if (!chromeFound) {
        console.log('Chromeが見つからないため、デフォルトブラウザで開きます');
        const child = spawn('cmd', ['/c', 'start', '', url], { 
          detached: true, 
          stdio: 'ignore' 
        });
        child.unref();
      }
      
    } else if (platform === 'darwin') {
      // macOS用
      console.log('macOS用のブラウザ起動');
      const child = spawn('open', ['-n', '-a', 'Google Chrome', '--args', ...chromeArgs], { 
        detached: true, 
        stdio: 'ignore' 
      });
      child.unref();
      
    }
    
    console.log('✅ 新規ブラウザウィンドウを開きました');
    return { success: true };
    
  } catch (error) {
    console.error('❌ ブラウザ起動エラー:', error);
    // フォールバック: shell.openExternalを使用
    shell.openExternal(url);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('minimize-window', () => {
  mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  mainWindow.close();
});

ipcMain.handle('skip-alert', (event, id) => {
  const alert = alerts.find(a => a.id === id);
  if (!alert) return false;
  
  // 繰り返しアラートの場合は次回の時間に更新
  if (alert.repeatType && alert.repeatType !== 'none') {
    scheduleNextRepeat(alert);
    return true;
  }
  
  return false;
});

ipcMain.handle('toggle-window', () => {
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.handle('save-settings', (event, settings) => {
  try {
    console.log('設定を保存中:', settings);
    globalSettings.timelineHotkey = settings.timelineHotkey;
    
    // 自動起動設定を更新
    if (settings.autoStartEnabled !== undefined) {
      autoStartEnabled = settings.autoStartEnabled;
      
      // セキュリティ強化: 自動起動を強制的に無効化
      autoStartEnabled = false;
      console.log('セキュリティのため自動起動を強制的に無効化します');
      
      // 自動起動設定を更新
      app.setLoginItemSettings({
        openAtLogin: false,  // 強制的にfalseに設定
        openAsHidden: true
      });
      console.log('自動起動設定を無効化しました:', autoStartEnabled);
    }
    
    saveSettings();
    
    // グローバルショートカットを更新
    updateGlobalShortcut();
    
    return { success: true };
  } catch (error) {
    console.error('設定の保存に失敗しました:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-settings', () => {
  try {
    return {
      success: true,
      settings: {
        timelineHotkey: globalSettings.timelineHotkey,
        autoStartEnabled: autoStartEnabled
      }
    };
  } catch (error) {
    console.error('設定の読み込みに失敗しました:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('settings-window-opened', () => {
  isSettingsWindowOpen = true;
  console.log('設定ウィンドウが開かれました - グローバルホットキーを無効化');
});

ipcMain.handle('settings-window-closed', () => {
  isSettingsWindowOpen = false;
  console.log('設定ウィンドウが閉じられました - グローバルホットキーを有効化');
});

ipcMain.handle('hotkey-capture-started', () => {
  isCapturingHotkey = true;
  console.log('ホットキーキャプチャが開始されました - グローバルホットキーを一時的に解除');
  
  // 既存のグローバルショートカットを一時的に解除
  if (currentGlobalShortcut) {
    try {
      globalShortcut.unregister(currentGlobalShortcut);
      console.log('グローバルショートカットを一時的に解除しました:', currentGlobalShortcut);
    } catch (error) {
      console.error('グローバルショートカットの解除に失敗しました:', error);
    }
  }
});

ipcMain.handle('hotkey-capture-stopped', () => {
  isCapturingHotkey = false;
  console.log('ホットキーキャプチャが停止されました - グローバルホットキーを再登録');
  
  // グローバルショートカットを再登録
  if (globalSettings.timelineHotkey && currentGlobalShortcut) {
    try {
      const success = globalShortcut.register(currentGlobalShortcut, () => {
        console.log('グローバルホットキーが押されました:', currentGlobalShortcut);
        
        // 設定ウィンドウが開いている場合やキャプチャ中の場合は無視
        if (isSettingsWindowOpen || isCapturingHotkey) {
          console.log('設定ウィンドウが開いているかキャプチャ中のため、ホットキーを無視します');
          return;
        }
        
        if (mainWindow) {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      });
      
      if (success) {
        console.log('グローバルショートカットを再登録しました:', currentGlobalShortcut);
      } else {
        console.error('グローバルショートカットの再登録に失敗しました:', currentGlobalShortcut);
      }
    } catch (error) {
      console.error('グローバルショートカット再登録エラー:', error);
    }
  }
});


// アラートの保存と読み込み
function saveAlerts() {
  try {
    const alertsPath = path.join(app.getPath('userData'), 'alerts.json');
    fs.writeFileSync(alertsPath, JSON.stringify(alerts, null, 2));
  } catch (error) {
    console.error('アラートの保存に失敗しました:', error);
  }
}

function loadAlerts() {
  try {
    const alertsPath = path.join(app.getPath('userData'), 'alerts.json');
    if (fs.existsSync(alertsPath)) {
      const data = fs.readFileSync(alertsPath, 'utf8');
      alerts = JSON.parse(data);
      
      // 期限切れのアラートを自動削除（繰り返しなしのもののみ）
      const now = new Date();
      const originalLength = alerts.length;
      alerts = alerts.filter(alert => {
        const alertTime = new Date(alert.dateTime);
        // 繰り返しアラートまたは未来のアラートのみ保持
        return (alert.repeatType && alert.repeatType !== 'none') || alertTime > now;
      });
      
      // 削除されたアラートがあれば保存
      if (alerts.length !== originalLength) {
        saveAlerts();
        console.log(`期限切れのアラートを${originalLength - alerts.length}個削除しました`);
      }
      
      // 既存のアラートのスケジュールを再設定
      alerts.forEach(alert => {
        if (new Date(alert.dateTime) > new Date()) {
          scheduleNotification(alert);
        }
      });
    }
  } catch (error) {
    console.error('アラートの読み込みに失敗しました:', error);
    alerts = [];
  }
}

// 新規ブラウザウィンドウを開く関数
function openNewBrowserWindow(url) {
  console.log('自動通知: 新規ブラウザウィンドウを開きます:', url);
  
  const platform = os.platform();
  console.log(`Platform: ${platform}`);
  
  // 専用プロファイルディレクトリを作成
  const userDataDir = path.join(os.homedir(), '.alerts-timeline-chrome-profile');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    console.log(`Created profile directory: ${userDataDir}`);
  }
  
  // 画面の中央にウィンドウを配置
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  
  const windowWidth = 1200;
  const windowHeight = 800;
  const centerX = Math.round((screenWidth - windowWidth) / 2);
  const centerY = Math.round((screenHeight - windowHeight) / 2);
  
  const windowPosition = `${centerX},${centerY}`;
  
  const chromeArgs = [
    '--new-window',
    '--no-default-browser-check',
    '--no-first-run', 
    '--disable-default-apps',
    `--user-data-dir=${userDataDir}`,
    `--window-position=${windowPosition}`,
    '--window-size=1200,800',
    url
  ];
  
  try {
    if (platform === 'win32') {
      // Windows用 - 複数のChromeパスを試行
      const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
      ];
      
      let chromeFound = false;
      for (const chromePath of chromePaths) {
        if (fs.existsSync(chromePath)) {
          console.log(`自動通知 Chrome起動: ${chromePath}`);
          
          const child = spawn(chromePath, chromeArgs, { 
            detached: true, 
            stdio: 'ignore' 
          });
          child.unref();
          
          chromeFound = true;
          break;
        }
      }
      
      if (!chromeFound) {
        console.log('自動通知: Chromeが見つからないため、デフォルトブラウザで開きます');
        const child = spawn('cmd', ['/c', 'start', '', url], { 
          detached: true, 
          stdio: 'ignore' 
        });
        child.unref();
      }
      
    } else if (platform === 'darwin') {
      // macOS用
      console.log('自動通知: macOS用のブラウザ起動');
      const child = spawn('open', ['-n', '-a', 'Google Chrome', '--args', ...chromeArgs], { 
        detached: true, 
        stdio: 'ignore' 
      });
      child.unref();
      
    }
    
    console.log('✅ 自動通知: 新規ブラウザウィンドウを開きました');
    
  } catch (error) {
    console.error('❌ 自動通知: ブラウザ起動エラー:', error);
    // フォールバック: shell.openExternalを使用
    shell.openExternal(url);
  }
}

// 通知のスケジュール
function scheduleNotification(alert) {
  // 既存のタイマーをクリア
  clearAlertTimers(alert.id);
  
  const alertTime = new Date(alert.dateTime);
  const now = new Date();
  
  if (alertTime > now) {
    const delay = alertTime.getTime() - now.getTime();
    const mainTimer = setTimeout(() => {
      // 通知を表示
      new Notification({
        title: '通知',
        body: alert.content,
        icon: path.join(__dirname, 'assets', 'icon.png')
      }).show();
      
      // n分前通知の設定がない場合は、本番通知時にURLを開く
      if (alert.url && (!alert.reminderMinutes || alert.reminderMinutes === 0)) {
        openNewBrowserWindow(alert.url);
      }
      
      // 繰り返し設定がある場合は次の通知をスケジュール
      if (alert.repeatType && alert.repeatType !== 'none') {
        scheduleNextRepeat(alert);
      }
      
      // 繰り返しなしの場合は終了後に自動削除
      if (!alert.repeatType || alert.repeatType === 'none') {
        const deleteTimer = setTimeout(() => {
          deleteExpiredAlert(alert.id);
        }, 5000); // 5秒後に削除
        
        // 削除タイマーも保存
        if (!alertTimers.has(alert.id)) {
          alertTimers.set(alert.id, []);
        }
        alertTimers.get(alert.id).push(deleteTimer);
      }
    }, delay);
    
    // メインタイマーを保存
    if (!alertTimers.has(alert.id)) {
      alertTimers.set(alert.id, []);
    }
    alertTimers.get(alert.id).push(mainTimer);
  }
  
  // n分前の通知
  if (alert.reminderMinutes && alert.reminderMinutes > 0) {
    const reminderTime = new Date(alertTime.getTime() - (alert.reminderMinutes * 60000));
    if (reminderTime > now) {
      const reminderDelay = reminderTime.getTime() - now.getTime();
      const reminderTimer = setTimeout(() => {
        new Notification({
          title: `${alert.reminderMinutes}分前のお知らせ`,
          body: alert.content,
          icon: path.join(__dirname, 'assets', 'icon.png')
        }).show();
        
        // n分前通知が設定されている場合は、この時にURLを開く
        if (alert.url) {
          openNewBrowserWindow(alert.url);
        }
      }, reminderDelay);
      
      // リマインダータイマーも保存
      if (!alertTimers.has(alert.id)) {
        alertTimers.set(alert.id, []);
      }
      alertTimers.get(alert.id).push(reminderTimer);
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
    case 'weekdays':
      nextTime = getNextWeekdayTime(currentTime, alert.weekdays);
      break;
    case 'monthly':
      nextTime.setMonth(nextTime.getMonth() + 1);
      break;
    case 'monthly-dates':
      nextTime = getNextMonthlyDateTime(currentTime, alert.dates);
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
    // 削除されたアラートが再スケジュールされないように確認
    const existingAlert = alerts[index];
    if (existingAlert && existingAlert.id === alert.id) {
      alerts[index] = updatedAlert;
      saveAlerts();
      scheduleNotification(updatedAlert);
      // レンダラープロセスに更新を通知
      if (mainWindow) {
        mainWindow.webContents.send('alert-updated', updatedAlert);
      }
    }
  }
}

// 次の指定曜日の時間を取得
function getNextWeekdayTime(currentTime, weekdays) {
  if (!weekdays || weekdays.length === 0) {
    return new Date(currentTime.getTime() + 24 * 60 * 60 * 1000); // 1日後
  }
  
  const now = new Date();
  const baseTime = new Date(currentTime);
  
  // 今日から始まって、次の該当曜日を探す
  for (let i = 1; i <= 7; i++) {
    const testDate = new Date(baseTime.getTime() + (i * 24 * 60 * 60 * 1000));
    const dayOfWeek = testDate.getDay();
    
    if (weekdays.includes(dayOfWeek)) {
      // 同じ日の場合は、時間をチェック
      if (i === 1 && testDate.getTime() <= now.getTime()) {
        continue; // まだ時間が来ていない場合はスキップ
      }
      return testDate;
    }
  }
  
  // 見つからない場合は1週間後（フォールバック）
  return new Date(baseTime.getTime() + 7 * 24 * 60 * 60 * 1000);
}

// 次の指定日付の時間を取得
function getNextMonthlyDateTime(currentTime, dates) {
  if (!dates || dates.length === 0) {
    // 日付が指定されていない場合は次の月の同じ日
    const nextMonth = new Date(currentTime);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return nextMonth;
  }
  
  const now = new Date();
  const baseTime = new Date(currentTime);
  
  // 今月の残りの日付をチェック
  const currentMonth = baseTime.getMonth();
  const currentYear = baseTime.getFullYear();
  const currentDate = baseTime.getDate();
  
  // 今月の指定日付の中で、今日以降の最も早い日付を探す
  const sortedDates = [...dates].sort((a, b) => a - b);
  for (const date of sortedDates) {
    if (date > currentDate) {
      const nextDate = new Date(currentYear, currentMonth, date, 
                               baseTime.getHours(), baseTime.getMinutes(), baseTime.getSeconds());
      if (nextDate > now) {
        return nextDate;
      }
    }
  }
  
  // 今月に該当する日付がない場合は来月の最初の指定日付
  const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
  const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
  
  // 来月の最初の指定日付
  const firstDate = Math.min(...sortedDates);
  const nextMonthDate = new Date(nextYear, nextMonth, firstDate, 
                                baseTime.getHours(), baseTime.getMinutes(), baseTime.getSeconds());
  
  // 月末日を考慮して調整
  const daysInMonth = new Date(nextYear, nextMonth + 1, 0).getDate();
  if (firstDate > daysInMonth) {
    // 指定日が存在しない場合は月末日に設定
    nextMonthDate.setDate(daysInMonth);
  }
  
  return nextMonthDate;
}

// アラートのタイマーをクリア
function clearAlertTimers(alertId) {
  if (alertTimers.has(alertId)) {
    const timers = alertTimers.get(alertId);
    timers.forEach(timer => clearTimeout(timer));
    alertTimers.delete(alertId);
  }
}

// 期限切れの通知を削除
function deleteExpiredAlert(id) {
  clearAlertTimers(id);
  alerts = alerts.filter(alert => alert.id !== id);
  saveAlerts();
  // レンダラープロセスに削除を通知
  if (mainWindow) {
    mainWindow.webContents.send('alert-deleted', id);
  }
}

