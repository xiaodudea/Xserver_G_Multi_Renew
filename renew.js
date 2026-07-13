const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ACC = process.env.ACC || process.env.EML;
const ACC_PWD = process.env.ACC_PWD || process.env.PWD;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_ID = process.env.TG_ID;
const PROXY_URL = process.env.PROXY_URL;

// 假设通过环境变量 INDEX 传入当前账号的序号 (如 1, 2) 默认是 1
const ACCOUNT_INDEX = process.env.INDEX || '1';
// 动态获取对应账号的 PLAN 环境变量，未找到则默认 16（即剩余小于等于16小时可续期）
const PLAN = process.env['PLAN_' + ACCOUNT_INDEX] || process.env.PLAN || '4';
// 续期阈值直接取 PLAN 的值
const RENEW_THRESHOLD = parseFloat(PLAN);

const LOGIN_URL = 'https://secure.xserver.ne.jp/xapanel/login/xmgame';
const STATUS_FILE = 'status.json';

let muteTg = false;

function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveStatus(data) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
}

function getAccountStatus() {
  return loadStatus()[ACC] || {};
}

function gitCommitPush(commitMsg) {
  try {
    execSync('git config --global user.email "bot@xserver.renew" && git config --global user.name "XServer Bot"', { stdio: 'pipe' });
    execSync('git add status.json', { stdio: 'pipe' });
    execSync('git commit -m "' + commitMsg + '"', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('📤 status.json 已推送');
    return true;
  } catch (e) {
    console.log('⚠️ Git 推送失败（非 Git 环境或无远程）');
    return false;
  }
}

function formatTimeUTC8(ts) {
  return new Date(ts + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

async function sendTG(statusIcon, statusText, extra, imagePath, force = false) {
  if (muteTg && !force) {
    console.log(`🔇 屏蔽TG通知 (${statusText}): 未到下次检查时间`);
    return;
  }

  if (!TG_TOKEN || !TG_ID) return;
  extra = extra || '';
  imagePath = imagePath || null;
  try {
    var time = formatTimeUTC8(Date.now());
    var text = 'XServer 延期提醒\n' + statusIcon + ' ' + statusText + '\n' + extra + '\n账号: ' + ACC + '\n时间: ' + time;
    if (imagePath && fs.existsSync(imagePath)) {
      var fileData = fs.readFileSync(imagePath);
      var fd = new FormData();
      fd.append('chat_id', TG_ID);
      fd.append('caption', text);
      fd.append('photo', new Blob([fileData], { type: 'image/png' }), path.basename(imagePath));
      var res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
      if (res.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res.status, await res.text());
    } else {
      var res2 = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_ID, text: text })
      });
      if (res2.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res2.status, await res2.text());
    }
  } catch (e) { console.log('⚠️ TG 发送失败:', e.message); }
}

function checkScheduling() {
  const now = Date.now();
  const s = getAccountStatus();
  
  let nextTime = s.nextCheckTime;
  
  if (!nextTime && s.nextCheckDate) {
    nextTime = new Date(s.nextCheckDate + 'T00:00:00+08:00').getTime();
  }

  if (!nextTime) { 
    console.log('🆕 首次运行或未找到限制时间，将正常执行'); 
    return; 
  }

  if (now < nextTime) {
    muteTg = true; // 只要没到下次时间，不管是定时还是手动运行，都静默TG通知 (除非 force = true 强行覆盖)
    console.log('⏳ 预约 ' + formatTimeUTC8(nextTime) + '，没到下次检查时间');

    if (process.env.GITHUB_EVENT_NAME === 'schedule' || process.env.CRON === 'true') {
      var hoursLeft = ((nextTime - now) / 3600000).toFixed(1);
      console.log('⏳ 定时任务还剩 ' + hoursLeft + ' 小时，秒退');
      process.exit(0);
    } else {
      console.log('💻 本地/手动触发模式：继续执行');
    }
  } else {
    console.log('📅 已到达或超过预约时间 ' + formatTimeUTC8(now) + '，正常执行');
  }
}

async function parseRemainingMinutes(page) {
  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    var text = await page.evaluate(function() {
      var el = document.querySelector('[class*="remain"], [class*="time"], [class*="period"]');
      if (el) return el.innerText;
      return document.body.innerText;
    });
    var m = text.match(/残り(\d+)時間(\d+)分/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时' + m[2] + '分钟'); return parseInt(m[1]) * 60 + parseInt(m[2]); }
    m = text.match(/残り(\d+)時間/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时'); return parseInt(m[1]) * 60; }
    m = text.match(/(\d+)時間(\d+)分/);
    if (m) { console.log('⏱️ 剩余时间: ' + m[1] + '小时' + m[2] + '分钟'); return parseInt(m[1]) * 60 + parseInt(m[2]); }
    console.log('⚠️ 未找到剩余时间');
    return null;
  } catch (e) { console.log('⚠️ 解析失败:', e.message); return null; }
}

// 统一按照精确到"小时"来更新下次检查时间
function updateNextCheckTime(hoursLater, reason) {
  const nextTime = Date.now() + hoursLater * 3600000;
  const nextTimeStr = formatTimeUTC8(nextTime);
  
  var status = loadStatus();
  if (!status[ACC]) status[ACC] = {};
  status[ACC].nextCheckTime = nextTime;
  status[ACC].nextCheckTimeStr = nextTimeStr; // 写入直观字符串方便 Git 留档和人类阅读
  delete status[ACC].nextCheckDate; // 清理旧格式
  
  saveStatus(status);
  console.log('📅 写入下次预约: ' + nextTimeStr + '（' + reason + '）');
  gitCommitPush('[Bot] ' + ACC + ' 下次检查 ' + nextTimeStr);
}

async function tryRenew(page, beforeMins) {
  let success = false;
  
  // 增加3次重试机制，每次失败间隔5分钟
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔄 [第 ${attempt}/3 次尝试] 滚动并查找延期按钮...`); 
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); 
      await page.waitForTimeout(2000);
      
      const btn = page.getByRole('link', { name: '期限を延長する' });
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      
      await btn.click();
      await page.waitForLoadState('load');
      await page.getByRole('button', { name: '確認画面に進む' }).click();
      await page.waitForLoadState('load');
      console.log('🖱️ 确认执行延期...');
      await page.getByRole('button', { name: '期限を延長する' }).click();
      await page.waitForLoadState('load');
      await page.screenshot({ path: '5_before_back.png' });
      
      console.log('✅ 延期点击成功，正在获取新的剩余时间...');
      await page.getByRole('link', { name: '戻る' }).click();
      await page.waitForLoadState('load');
      await page.screenshot({ path: 'success.png' });
      
      success = true;
      break; // 成功则跳出重试循环
      
    } catch (e) {
      console.log(`⚠️ 第 ${attempt} 次未找到按钮或操作失败`);
      if (attempt < 3) {
        console.log('⏳ 可能是时间卡点边缘，等待 5 分钟后刷新重试...');
        await page.waitForTimeout(5 * 60 * 1000); // 等待 5 分钟
        await page.reload({ waitUntil: 'load' }); // 刷新页面
      }
    }
  }

  // 结算结果
  if (success) {
    var afterMins = await parseRemainingMinutes(page);
    var beforeH = beforeMins ? (beforeMins / 60).toFixed(1) : '?';
    var afterH = afterMins ? (afterMins / 60).toFixed(1) : '?';
    var timeInfo = '续签前 ' + beforeH + 'h → 续签后 ' + afterH + 'h';
    console.log('⏱️ ' + timeInfo);
    
    var status = loadStatus();
    if (!status[ACC]) status[ACC] = {};
    status[ACC].lastSuccess = Date.now();
    saveStatus(status);
    
    // 计算下次检查时间: 新剩余时间减去阈值，保底至少1小时后
    var checkDelayHours = afterH !== '?' ? Math.max(1, afterH - RENEW_THRESHOLD) : 24; 
    updateNextCheckTime(checkDelayHours, '续签成功计算');
    
    // 成功一定强制通知
    await sendTG('✅', '续签成功', timeInfo + `\n下次检查${checkDelayHours.toFixed(1)}小时后`, 'success.png', true);
  } else {
    console.log('❌ 3次尝试均未找到延期按钮');
    await page.screenshot({ path: 'skip.png' });
    
    // 既然已经是续期时间但由于未知原因没按出来，延迟 1 小时后重新走完整流程
    updateNextCheckTime(1, '重试失败，延迟1小时重试');
    await sendTG('⚠️', '续签异常', '已达续签时间但重试3次均未找到按钮，1小时后重试', 'skip.png', true);
  }
}

(async function main() {
  console.log('==================================================');
  console.log(`XServer 自动延期 (阈值重构版) - 账号位: #${ACCOUNT_INDEX}`);
  console.log(`当前配置: PLAN_${ACCOUNT_INDEX}=${PLAN}h (当剩余时间 <= ${RENEW_THRESHOLD}h 时可续期)`);
  console.log('==================================================');

  if (!ACC || !ACC_PWD) { console.log('❌ 未找到账号或密码'); process.exit(1); }
  
  checkScheduling();

  var launchOpts = { headless: true, channel: 'chrome' };
  if (PROXY_URL) launchOpts.proxy = { server: 'http://127.0.0.1:8080' };

  var browser = await chromium.launch(launchOpts);
  var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  var page = await context.newPage();

  try {
    if (PROXY_URL) {
      console.log('🌐 检查代理 IP...');
      try {
        await page.goto('https://api.ipify.org/?format=json', { timeout: 15000 });
        console.log('✅ IP: ' + JSON.parse(await page.textContent('body')).ip);
      } catch (e) { console.log('⚠️ IP 检查失败'); }
    }

    console.log('🌐 打开登录页面');
    await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30000 });
    await page.screenshot({ path: '1_navigation.png' });

    console.log('📧 填写账号密码');
    await page.locator('#memberid').fill(ACC);
    await page.locator('#user_password').fill(ACC_PWD);
    await page.screenshot({ path: '1.5_filled.png' });

    console.log('🖱️ 提交登录');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
      page.locator('input[name="action_user_login"]').click()
    ]);
    await page.screenshot({ path: '2_after_login.png' });

    console.log('🚀 点击游戏管理');
    await page.getByRole('link', { name: 'ゲーム管理' }).click();
    await page.waitForLoadState('load');
    await page.screenshot({ path: '3_game_manage.png' });

    var totalMins = await parseRemainingMinutes(page);
    console.log('🚀 准备续签判断...');
    await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();
    await page.screenshot({ path: '4_renew_page.png' });

    if (totalMins === null) {
      console.log('⚠️ 无法解析剩余时间，尝试直接强制续签');
      await tryRenew(page, null);
    } else {
      var h = totalMins / 60;
      if (h <= RENEW_THRESHOLD) {
        console.log(`🚨 续期模式: 剩余 ${h.toFixed(1)} 小时，满足 <= ${RENEW_THRESHOLD}h 规则，立即执行续期！`);
        await tryRenew(page, totalMins);
      } else {
        // 未到时间的探测，计算距离下次达到阈值还差多久
        var skipHours = Math.max(0.5, h - RENEW_THRESHOLD);
        console.log(`🔭 探测模式: 剩余 ${h.toFixed(1)} 小时，大于阈值 ${RENEW_THRESHOLD}h → 预约 ${skipHours.toFixed(1)} 小时后检查`);
        updateNextCheckTime(skipHours, `剩余时间较多，跳过${skipHours.toFixed(1)}小时`);
        // 按照需求：未到时间的续期不通知，故此处不调用 sendTG
      }
    }

  } catch (error) {
    console.log('❌ 流程失败: ' + error.message);
    await page.screenshot({ path: 'failure.png' });
    await sendTG('❌', '脚本运行失败', error.message, 'failure.png', true);
  } finally {
    await context.close();
    await browser.close();
  }
})();
