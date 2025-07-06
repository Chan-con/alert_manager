const { app, BrowserWindow, ipcMain, shell, Notification, Tray, Menu } = require('electron');
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
      label: 'PC起動時に自動開始',
      type: 'checkbox',
      checked: autoStartEnabled,
      click: () => {
        toggleAutoStart();
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

  tray.setContextMenu(contextMenu);
}

// 自動起動の設定を管理する関数
function toggleAutoStart() {
  autoStartEnabled = !autoStartEnabled;
  
  app.setLoginItemSettings({
    openAtLogin: autoStartEnabled,
    openAsHidden: true,
    path: process.execPath,
    args: ['--hidden']
  });
  
  saveSettings();
  updateTrayMenu();
}

// 現在の自動起動状態を取得
function getAutoStartStatus() {
  const loginItemSettings = app.getLoginItemSettings();
  autoStartEnabled = loginItemSettings.openAtLogin;
  return autoStartEnabled;
}

// 設定を保存
function saveSettings() {
  const settingsPath = path.join(__dirname, 'settings.json');
  const settings = {
    autoStartEnabled: autoStartEnabled
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// 設定を読み込み
function loadSettings() {
  const settingsPath = path.join(__dirname, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const data = fs.readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(data);
      autoStartEnabled = settings.autoStartEnabled || false;
    } catch (error) {
      console.error('設定読み込みエラー:', error);
      autoStartEnabled = false;
    }
  }
  
  // 現在のシステム設定と同期
  getAutoStartStatus();
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
        
      } else {
        // Linux用 - 複数のブラウザを試行
        console.log('Linux用のブラウザ起動');
        
        const browsers = [
          { cmd: 'google-chrome', args: chromeArgs },
          { cmd: 'chromium-browser', args: chromeArgs },
          { cmd: 'firefox', args: ['-new-window', url] },
          { cmd: 'xdg-open', args: [url] }
        ];
        
        let browserFound = false;
        for (const browser of browsers) {
          try {
            console.log(`Trying ${browser.cmd}...`);
            spawn(browser.cmd, browser.args, { 
              detached: true, 
              stdio: 'ignore' 
            });
            console.log(`Successfully launched ${browser.cmd}`);
            browserFound = true;
            break;
          } catch (error) {
            console.log(`Failed to launch ${browser.cmd}: ${error.message}`);
            continue;
          }
        }
        
        if (!browserFound) {
          console.log('No browser found');
        }
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
      
    } else {
      // Linux用
      console.log('Linux用のブラウザ起動');
      const child = spawn('google-chrome', chromeArgs, { 
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


// アラートの保存と読み込み
function saveAlerts() {
  try {
    const alertsPath = path.join(__dirname, 'alerts.json');
    fs.writeFileSync(alertsPath, JSON.stringify(alerts, null, 2));
  } catch (error) {
    console.error('アラートの保存に失敗しました:', error);
  }
}

function loadAlerts() {
  try {
    const alertsPath = path.join(__dirname, 'alerts.json');
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
      
    } else {
      // Linux用
      console.log('自動通知: Linux用のブラウザ起動');
      const child = spawn('google-chrome', chromeArgs, { 
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
        openNewBrowserWindow(alert.url);
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
          openNewBrowserWindow(alert.url);
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

