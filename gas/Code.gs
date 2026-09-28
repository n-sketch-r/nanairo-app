/**
 * 【なないろ菜】統合管理システム GAS 脳みそ
 * ★無料枠節約キャッシュ対応 ＋ 委託販売機能 ＆ 任意日付対応 完全版
 *
 * ★このファイルには秘密の値（LINEトークン・管理パスワードのハッシュ）を書かないこと。
 *   秘密の値は「プロジェクトの設定 → スクリプト プロパティ」に保存する：
 *     LINE_TOKEN             … LINE Messaging API のチャネルアクセストークン
 *     ADMIN_PASSWORD_SHA256  … 管理画面パスワードの SHA-256 ハッシュ値
 *   設定できているかは、エディタで checkSettings を実行すると確認できる（値そのものは表示しない）。
 */

const SS = SpreadsheetApp.getActiveSpreadsheet();
const SHEET_ORDERS = SS.getSheetByName("Orders");
const SHEET_PRODUCTS = SS.getSheetByName("Products");
const SHEET_STOCK_LOGS = SS.getSheetByName("StockLogs");
const SHEET_AGENCIES = SS.getSheetByName("Agencies");
const SHEET_AGENCY_PRICES = SS.getSheetByName("AgencyPrices");
const SHEET_AGENCY_DELIVERIES = SS.getSheetByName("AgencyDeliveries");

const PROPS = PropertiesService.getScriptProperties();
const LINE_TOKEN = PROPS.getProperty("LINE_TOKEN") || "";
const LINE_GROUP_ID = "Cd07d6fe0c484b4759f549b862169090e";

/* ===== ★セキュリティ設定 ===== */
// 管理画面のパスワード（SHA-256のハッシュ値のみ。スクリプト プロパティに保存）
const ADMIN_PASSWORD_SHA256 = String(PROPS.getProperty("ADMIN_PASSWORD_SHA256") || "").trim().toLowerCase();
// LINEログインのチャネルID（LIFF ID の「-」より前の数字）
const LINE_LOGIN_CHANNEL_ID = "2010021938";
// true にすると、LINEの本人確認（IDトークン）が無い注文・キャンセル・履歴取得を拒否します
const REQUIRE_LINE_ID_TOKEN = true; // 2026-09-28 本人確認の動作を確認済み（false に戻すと移行モード）

// エディタから実行して、秘密の値が設定されているか確認する（値そのものはログに出さない）
function checkSettings() {
  Logger.log("LINE_TOKEN: " + (LINE_TOKEN ? "設定済み" : "★未設定（LINE通知が送れません）"));
  Logger.log("ADMIN_PASSWORD_SHA256: " + (/^[0-9a-f]{64}$/.test(ADMIN_PASSWORD_SHA256) ? "設定済み" : "★未設定または形式が違います（管理画面に入れません）"));
  Logger.log("IDTOKEN_OK_AT（本人確認に成功した最後の日時）: " + (PROPS.getProperty("IDTOKEN_OK_AT") || "まだ記録なし"));
  Logger.log("IDTOKEN_MISSING_AT（本人確認なしの注文等の最後の日時）: " + (PROPS.getProperty("IDTOKEN_MISSING_AT") || "まだ記録なし"));
  const header = SHEET_ORDERS.getRange(1, 1, 1, SHEET_ORDERS.getLastColumn()).getValues()[0];
  Logger.log("Ordersの見出し Q列: " + (header[COL_ORD_ID] || "★未設定（setupOrderColumns を実行してください）") + " / R列: " + (header[COL_ORD_PAID] || "★未設定"));
}

// エディタから実行して、スタッフのLINEグループにテスト通知を送る（トークンを差し替えた後の確認用）
function testGroupNotification() {
  if (!LINE_TOKEN) { Logger.log("LINE_TOKEN が未設定です"); return; }
  const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    "method": "post",
    "headers": { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
    "payload": JSON.stringify({ "to": LINE_GROUP_ID, "messages": [{ "type": "text", "text": "【テスト】LINE通知の確認です。このメッセージは無視してください。" }] }),
    "muteHttpExceptions": true
  });
  Logger.log(res.getResponseCode() === 200 ? "送信できました（トークンは正常です）" : "送信できませんでした: " + res.getResponseCode() + " " + res.getContentText());
}

function sha256Hex(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}

// 管理者チェック（パスワード不一致ならエラー）
function requireAdmin(data) {
  const key = String((data && data.adminKey) || "");
  if (!/^[0-9a-f]{64}$/.test(ADMIN_PASSWORD_SHA256)) throw new Error("管理パスワードがサーバーに設定されていません。");
  if (!key || sha256Hex(key) !== ADMIN_PASSWORD_SHA256) {
    Utilities.sleep(800); // 総当たり対策で少し待たせる
    throw new Error("AUTH_REQUIRED");
  }
}

// LINEのIDトークンをLINEのサーバーで検証し、本人の userId と表示名を返す
// verified: LINEで本人確認できたかどうか（移行モードで画面のIDをそのまま使った場合は false）
function verifyLineUser(data) {
  const idToken = String((data && data.idToken) || "");
  if (!idToken) {
    try { PROPS.setProperty("IDTOKEN_MISSING_AT", new Date().toISOString()); } catch (e) {}
    if (REQUIRE_LINE_ID_TOKEN) throw new Error("LINEアプリから開き直してください（本人確認ができませんでした）。");
    return { userId: String(data.userId || ""), name: String(data.userName || ""), verified: false };
  }
  const cache = CacheService.getScriptCache();
  const ck = "idt_" + sha256Hex(idToken).substring(0, 40);
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "post",
    payload: { id_token: idToken, client_id: LINE_LOGIN_CHANNEL_ID },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error("ログインの有効期限が切れました。画面を閉じて、もう一度開いてください。");
  const body = JSON.parse(res.getContentText());
  const user = { userId: String(body.sub || ""), name: String(body.name || data.userName || ""), verified: true };
  if (!user.userId) throw new Error("本人確認ができませんでした。");
  cache.put(ck, JSON.stringify(user), 600);
  try { PROPS.setProperty("IDTOKEN_OK_AT", new Date().toISOString()); } catch (e) {}
  return user;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 列定義: Products
const COL_PROD_ID = 0;
const COL_PROD_NAME = 1;
const COL_PROD_PRICE = 2;
const COL_PROD_WEIGHT = 3;
const COL_PROD_STOCK = 4;

const COL_ORD_STATUS = 8;
const COL_ORD_SENMU_CHECK = 9;
const COL_ORD_CAFE_CHECK = 10;
// ★配送対応で追加した列（L〜P）
const COL_ORD_METHOD = 11;   // L: 受取方法（店頭受取 / 配送）
const COL_ORD_ADDRESS = 12;  // M: 配送先住所
const COL_ORD_PHONE = 13;    // N: 電話番号
const COL_ORD_SHIPPING = 14; // O: 配送料
const COL_ORD_STORE = 15;    // P: 店舗名・会社名（飲食店のお客様向け・任意）
// ★注文IDと集金済（Q〜R）
const COL_ORD_ID = 16;       // Q: 注文ID（行を消してもずれない固有の番号）
const COL_ORD_PAID = 17;     // R: 集金済
const ORD_COLS = 18;

const ORDER_STATUSES = ["未対応", "準備完了", "受渡済", "キャンセル"];

// ★初回だけエディタから実行：Q・R列の見出しを作り、既存の注文すべてに注文IDを付ける
function setupOrderColumns() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    SHEET_ORDERS.getRange(1, COL_ORD_ID + 1, 1, 2).setValues([["注文ID", "集金済"]]);
    const last = SHEET_ORDERS.getLastRow();
    if (last < 2) return;
    const range = SHEET_ORDERS.getRange(2, COL_ORD_ID + 1, last - 1, 1);
    const ids = range.getValues();
    let added = 0;
    ids.forEach(r => { if (!r[0]) { r[0] = newOrderId(); added++; } });
    range.setValues(ids);
    Logger.log("注文IDを付けた件数: " + added);
  } finally {
    lock.releaseLock();
  }
}

function newOrderId() {
  return "ord_" + Utilities.getUuid().replace(/-/g, "").substring(0, 16);
}

// 注文IDから行番号（1始まり）を探す。見つからなければ -1
// 注文IDが未設定の古い行だけ、以前の「o行番号」形式でも探す
function findOrderRow(values, orderId) {
  const id = String(orderId || "");
  if (!id) return -1;
  for (let i = 1; i < values.length; i++) {
    const rowId = String(values[i][COL_ORD_ID] || "");
    if (rowId ? rowId === id : ("o" + (i + 1)) === id) return i + 1;
  }
  return -1;
}

// ★配送ルール（変更する場合はここだけ直せばOK。注文画面 index.html の DELIVERY も合わせて変更）
const DELIVERY = {
  days: [1, 2],                 // 配送できる曜日（0=日,1=月,2=火 ...）
  time: "16:00-17:00",          // 配送時間帯
  freeThreshold: 1000,          // この金額（商品合計・税込）以上で送料無料
  fee: 500,                     // 送料（税込）
  areas: ["鶴岡市", "酒田市", "三川町", "庄内町", "遊佐町"] // 庄内一円
};
const METHOD_DELIVERY = "配送";
const METHOD_PICKUP = "店頭受取";

function doGet(e) {
  // ★公開してよいのは商品一覧だけ。管理データ・注文履歴は doPost（認証あり）で返す
  try {
    const action = e && e.parameter ? e.parameter.action : "";
    if (action === "getAdminData" || action === "getUserOrders") {
      return jsonOut({ status: "error", message: "AUTH_REQUIRED" });
    }
    return jsonOut(fetchProducts());
  } catch (err) {
    return jsonOut({ status: "error", message: "商品データの取得に失敗しました。" });
  }
}

// ★スプレッドシートを直接編集したとき、商品一覧のキャッシュを消す（在庫・価格の変更をすぐ画面に反映）
function onEdit(e) {
  try {
    const name = e && e.range ? e.range.getSheet().getName() : "";
    if (name === "Products" || name === "Agencies" || name === "AgencyPrices") clearProductsCache();
  } catch (err) {}
}

// 管理画面の読み込みデータ
function buildAdminData(data) {
  const targetMonth = data.month;
  const endMonth = data.endMonth || targetMonth;
  const allOrders = fetchOrders();
  return {
    products: fetchProducts(),
    orders: allOrders,
    analytics: calculateAnalytics(allOrders, targetMonth, endMonth),
    stockLogs: fetchStockLogs(),
    agencies: fetchAgencies(),
    agencyPrices: fetchAgencyPrices(),
    agencyDeliveries: fetchAgencyDeliveries(targetMonth, endMonth),
    insights: buildInsights(allOrders, targetMonth, endMonth)
  };
}

function doPost(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return ContentService.createTextOutput("No data");
  }

  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput("Error");
  }

  // LINE Webhook対応（グループID取得など）
  if (data.events || data.destination) {
    if (data.events && data.events.length > 0) {
      const event = data.events[0];
      if (event.type === 'message' && event.message && event.message.text === 'ID教えて') {
        if (event.source && (event.source.type === 'group' || event.source.type === 'room')) {
          const groupId = event.source.groupId || event.source.roomId;
          if (event.replyToken) {
            UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
              "method": "post",
              "headers": { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
              "payload": JSON.stringify({
                "replyToken": event.replyToken,
                "messages": [{"type": "text", "text": "このグループのIDは以下の通りです。コピーしてGASの LINE_GROUP_ID に貼り付けてください。\n\n" + groupId}]
              }),
              "muteHttpExceptions": true
            });
          }
        }
      }
    }
    return ContentService.createTextOutput("OK");
  }

  const action = data.action || "order";
  const ADMIN_ACTIONS = ["getAdminData", "stockUpdate", "bulkLoss", "cancelStockLog", "statusUpdate", "toggleCheck",
    "agencyDelivery", "agencyInventory", "cancelAgencyDelivery", "cancelAgencyInventory", "checkAdmin"];
  const CUSTOMER_ACTIONS = ["order", "cancelOrder", "getUserOrders", "getProfile", "saveProfile"];

  // --- 認証 ---
  let verified = false;
  try {
    if (ADMIN_ACTIONS.indexOf(action) > -1) requireAdmin(data);
    else if (CUSTOMER_ACTIONS.indexOf(action) > -1) {
      const user = verifyLineUser(data);
      data.userId = user.userId;            // 画面から送られたIDは信用せず、LINEで確認したIDに置き換える
      if (user.name) data.userName = user.name;
      verified = !!user.verified;
    } else throw new Error("不明なアクションが指定されました: " + action);
  } catch (err) {
    return jsonOut({ status: "error", message: String(err.message || err) });
  }

  // --- 読み取り専用（ロック不要） ---
  try {
    if (action === "checkAdmin") return jsonOut({ status: "success" });
    if (action === "getAdminData") return jsonOut(buildAdminData(data));
    if (action === "getProfile") {
      // 本人確認が取れたときだけ登録情報を返す
      return jsonOut({ status: "success", profile: verified && data.userId ? findCustomer(data.userId) : null });
    }
    if (action === "getUserOrders") {
      if (!data.userId) return jsonOut([]);
      const mine = fetchOrders().filter(o => o.userId === data.userId);
      // ★本人確認が取れていないときは、住所・電話番号を返さない（他人になりすました閲覧への対策）
      return jsonOut(mine.map(o => {
        const out = Object.assign({}, o);
        if (!verified) { delete out.address; delete out.phone; }
        return out;
      }));
    }
  } catch (err) {
    return jsonOut({ status: "error", message: String(err.message || err) });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: "サーバーが混み合っています。数秒待ってからもう一度お試しください。"
    })).setMimeType(ContentService.MimeType.JSON);
  }

  let response = { status: "success" };

  try {
    if (action === "order") response = Object.assign(response, processNewOrder(data));
    else if (action === "saveProfile") response.profile = saveCustomer(data, verified);
    else if (action === "stockUpdate") processStockAdjustment(data);
    else if (action === "bulkLoss") processBulkLoss(data);
    else if (action === "cancelStockLog") processCancelStockLog(data);
    else if (action === "statusUpdate") processStatusChange(data);
    else if (action === "cancelOrder") processCancelOrder(data);
    else if (action === "toggleCheck") processToggleCheck(data);
    else if (action === "agencyDelivery") processAgencyDelivery(data);
    else if (action === "agencyInventory") processAgencyInventory(data);
    else if (action === "cancelAgencyDelivery") processCancelAgencyDelivery(data);
    else if (action === "cancelAgencyInventory") processCancelAgencyInventory(data);
    else throw new Error("不明なアクションが指定されました: " + action);
  } catch (err) {
    response = { status: "error", message: err.toString() };
  } finally {
    lock.releaseLock();
  }

  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

function clearProductsCache() {
  CacheService.getScriptCache().remove("products_cache");
  CacheService.getScriptCache().remove("agencies_cache");
  CacheService.getScriptCache().remove("agency_prices_cache");
}

function fetchProducts() {
  const cache = CacheService.getScriptCache();
  const cachedData = cache.get("products_cache");

  if (cachedData) {
    return JSON.parse(cachedData);
  }

  const values = SHEET_PRODUCTS.getDataRange().getValues();
  values.shift();
  const products = values.map(row => ({
    id: String(row[COL_PROD_ID] || ""),
    name: String(row[COL_PROD_NAME] || ""),
    price: Number(row[COL_PROD_PRICE] || 0),
    weight: String(row[COL_PROD_WEIGHT] || "") + "g",
    stock: Number(row[COL_PROD_STOCK] || 0)
  }));

  cache.put("products_cache", JSON.stringify(products), 21600);
  return products;
}

function fetchAgencies() {
  const cache = CacheService.getScriptCache();
  const cachedData = cache.get("agencies_cache");
  if (cachedData) return JSON.parse(cachedData);

  const values = SHEET_AGENCIES.getDataRange().getValues();
  if (values.length <= 1) return [];
  values.shift();
  const agencies = values.map(row => ({
    id: String(row[0] || ""),
    name: String(row[1] || ""),
    feeRate: Number(row[2] || 0)
  }));
  cache.put("agencies_cache", JSON.stringify(agencies), 21600);
  return agencies;
}

function fetchAgencyPrices() {
  const cache = CacheService.getScriptCache();
  const cachedData = cache.get("agency_prices_cache");
  if (cachedData) return JSON.parse(cachedData);

  const values = SHEET_AGENCY_PRICES.getDataRange().getValues();
  if (values.length <= 1) return [];
  values.shift();
  const prices = values.map(row => ({
    agencyId: String(row[0] || ""),
    productId: String(row[1] || ""),
    storePrice: Number(row[2] || 0)
  }));
  cache.put("agency_prices_cache", JSON.stringify(prices), 21600);
  return prices;
}

function fetchAgencyDeliveries(startMonthStr, endMonthStr) {
  const values = SHEET_AGENCY_DELIVERIES.getDataRange().getValues();
  if (values.length <= 1) return [];
  values.shift();

  const deliveries = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    let dateStr = "";
    if (row[1] instanceof Date) dateStr = Utilities.formatDate(row[1], "JST", "yyyy-MM-dd");
    else dateStr = String(row[1] || "").substring(0, 10).replace(/\//g, '-');

    const logMonth = dateStr.substring(0, 7);
    if (!startMonthStr || (logMonth >= startMonthStr && logMonth <= endMonthStr)) {
      deliveries.push({
        id: String(row[0] || ""),
        rowIndex: i + 2,
        date: dateStr,
        agencyId: String(row[2] || ""),
        agencyName: String(row[3] || ""),
        productId: String(row[4] || ""),
        productName: String(row[5] || ""),
        deliveryQty: Number(row[6] || 0),
        salesQty: Number(row[7] || 0),
        lossQty: Number(row[8] || 0),
        salesAmountExTax: Number(row[9] || 0),
        feeAmountExTax: Number(row[10] || 0),
        pureSalesExTax: Number(row[11] || 0),
        status: String(row[12] || "")
      });
    }
  }
  return deliveries;
}

function fetchOrders() {
  const values = SHEET_ORDERS.getDataRange().getValues();
  if (values.length <= 1) return [];
  values.shift();

  return values.map((row, index) => {
    const itemsStr = String(row[1] || "");
    const itemsList = itemsStr.split("\n").map(s => {
      const p = s.split(" × ");
      return p.length === 2 ? { name: p[0].trim(), qty: parseInt(p[1], 10) } : null;
    }).filter(Boolean);

    let formattedDate = row[6] instanceof Date ? Utilities.formatDate(row[6], "JST", "yyyy-MM-dd HH:mm") : String(row[6] || "").replace(/\//g, '-');
    let formattedPickupDate = row[2] instanceof Date ? Utilities.formatDate(row[2], "JST", "yyyy-MM-dd") : String(row[2] || "").substring(0, 10).replace(/\//g, '-');

    return {
      // ★注文IDがあればそれを使う（無い古い行だけ、以前の「o行番号」）
      id: String(row[COL_ORD_ID] || "") || ("o" + (index + 2)), userName: String(row[0] || ""), itemsList: itemsList,
      pickupDate: formattedPickupDate, pickupTime: String(row[3] || ""), memo: String(row[4] || ""),
      totalPrice: Number(row[5] || 0), orderDate: formattedDate, userId: String(row[7] || ""),
      status: String(row[COL_ORD_STATUS] || "未対応"), senmuChecked: Boolean(row[COL_ORD_SENMU_CHECK]), cafeChecked: Boolean(row[COL_ORD_CAFE_CHECK]),
      paidChecked: Boolean(row[COL_ORD_PAID]),
      // ★配送対応（以前の注文は列が空なので「店頭受取」扱い）
      deliveryMethod: String(row[COL_ORD_METHOD] || METHOD_PICKUP),
      address: String(row[COL_ORD_ADDRESS] || ""),
      phone: String(row[COL_ORD_PHONE] || ""),
      shippingFee: Number(row[COL_ORD_SHIPPING] || 0),
      storeName: String(row[COL_ORD_STORE] || "")
    };
  }).reverse();
}

function fetchStockLogs() {
  const values = SHEET_STOCK_LOGS.getDataRange().getValues();
  if (values.length <= 1) return [];
  const products = fetchProducts();
  const nameMap = {};
  products.forEach(p => { nameMap[p.id] = p.name; });

  const logs = [];
  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    let formattedDate = row[0] instanceof Date ? Utilities.formatDate(row[0], "JST", "MM/dd HH:mm") : String(row[0] || "").substring(5, 16).replace('-', '/');
    logs.push({
      rowIndex: i + 1, date: formattedDate, productId: String(row[1] || ""), name: nameMap[String(row[1] || "")] || "不明",
      type: String(row[2] || ""), amount: Number(row[3] || 0), memo: String(row[4] || ""), status: String(row[5] || "")
    });
    if (logs.length >= 30) break;
  }
  return logs;
}

function calculateAnalytics(allOrders, startMonthStr, endMonthStr) {
  // ★受取日（配送日）で期間に振り分ける（注文日だと月末の注文が請求明細書から漏れるため）
  const targetOrders = allOrders.filter(o => {
    if (!o.pickupDate || o.status === "キャンセル") return false;
    const pickupMonth = o.pickupDate.substring(0, 7);
    return pickupMonth >= startMonthStr && pickupMonth <= endMonthStr;
  });

  let directSalesTotal = targetOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
  let orderCount = targetOrders.length;
  const customerMap = {};
  const productSales = {};

  targetOrders.forEach(o => {
    const cid = o.userId || o.userName;
    if (!customerMap[cid]) customerMap[cid] = { userId: cid, userName: o.userName, totalSpend: 0, orderCount: 0, items: {}, detailedOrders: [] };
    customerMap[cid].totalSpend += (o.totalPrice || 0);
    customerMap[cid].orderCount += 1;
    o.itemsList.forEach(item => {
      if (item && item.name) {
        customerMap[cid].items[item.name] = (customerMap[cid].items[item.name] || 0) + item.qty;
        productSales[item.name] = (productSales[item.name] || 0) + item.qty;
        customerMap[cid].detailedOrders.push({ date: o.pickupDate, name: item.name, qty: item.qty });
      }
    });
    // ★配送料は請求明細書に「配送料」行として出す（商品ランキングには含めない）
    if (o.shippingFee > 0) {
      customerMap[cid].detailedOrders.push({ date: o.pickupDate, name: "配送料", qty: 1, unitPrice: o.shippingFee, isShipping: true });
    }
  });

  const stockData = calculateStockStats(startMonthStr, endMonthStr);
  directSalesTotal += stockData.directSalesAmount;
  orderCount += stockData.directSalesCount;

  Object.keys(stockData.directSalesItems).forEach(itemName => {
    productSales[itemName] = (productSales[itemName] || 0) + stockData.directSalesItems[itemName];
  });

  const deliveries = fetchAgencyDeliveries(startMonthStr, endMonthStr);
  let agencySalesTotal = 0;
  let agencyLossAmount = 0;
  const agencyLossStats = {};
  const products = fetchProducts();

  deliveries.forEach(d => {
    if (d.status === "精算済") {
      agencySalesTotal += Math.floor(d.pureSalesExTax * 1.08);
      productSales[d.productName] = (productSales[d.productName] || 0) + d.salesQty;
    }
    if (d.status !== "取消") {
      if (!agencyLossStats[d.agencyName]) agencyLossStats[d.agencyName] = { harvestQty: 0, lossQty: 0 };
      agencyLossStats[d.agencyName].harvestQty += d.deliveryQty;
      if (d.status === "精算済") {
          agencyLossStats[d.agencyName].lossQty += d.lossQty;
          const p = products.find(prod => prod.id === d.productId);
          agencyLossAmount += (p ? p.price : 0) * d.lossQty;
      }
    }
  });

  const agencyLossRates = Object.keys(agencyLossStats).map(agencyName => {
    const stat = agencyLossStats[agencyName];
    return { name: agencyName, deliveryQty: stat.harvestQty, lossQty: stat.lossQty, lossRate: stat.harvestQty > 0 ? Math.round((stat.lossQty / stat.harvestQty) * 100) : 0 };
  });

  Object.keys(customerMap).forEach(cid => {
    customerMap[cid].detailedOrders.sort((a, b) => new Date(a.date) - new Date(b.date));
  });

  const topCustomers = Object.values(customerMap).sort((a, b) => b.totalSpend - a.totalSpend);
  const topProducts = Object.entries(productSales).sort((a, b) => b[1] - a[1]).map(([name, qty]) => ({ name, qty }));

  return {
    monthlySales: directSalesTotal + agencySalesTotal,
    directSalesTotal: directSalesTotal,
    agencySalesTotal: agencySalesTotal,
    orderCount: orderCount,
    averageSpend: orderCount ? Math.round(directSalesTotal / orderCount) : 0,
    topCustomers: topCustomers,
    topProducts: topProducts,
    lossAmount: stockData.totalLossAmount + agencyLossAmount,
    stockStats: stockData.stats,
    agencyLossRates: agencyLossRates
  };
}

function calculateStockStats(startMonthStr, endMonthStr) {
  const logs = SHEET_STOCK_LOGS.getDataRange().getValues();
  const products = fetchProducts();
  const priceMap = {}; const nameMap = {};
  products.forEach(p => { priceMap[p.id] = p.price; nameMap[p.id] = p.name; });

  const statsMap = {};
  let totalLossAmount = 0; let directSalesAmount = 0; let directSalesCount = 0; let directSalesItems = {};

  if (logs.length > 1) {
    logs.shift();
    logs.forEach(row => {
      if (String(row[5] || "") === "取消") return;
      const logDateObj = row[0]; const pId = String(row[1] || ""); const logType = String(row[2] || "");
      const qty = Number(row[3] || 0); const itemName = nameMap[pId] || "不明";

      let logMonth = logDateObj instanceof Date ? Utilities.formatDate(logDateObj, "JST", "yyyy-MM") : String(logDateObj || "").replace(/\//g, '-').substring(0, 7);

      if (logMonth >= startMonthStr && logMonth <= endMonthStr) {
        if (!statsMap[pId]) statsMap[pId] = { harvestQty: 0, lossQty: 0 };
        if (logType.includes("収穫") || logType.includes("追加")) statsMap[pId].harvestQty += qty;
        else if ((logType.includes("ロス") || logType.includes("破棄")) && !logType.includes("委託")) {
          statsMap[pId].lossQty += qty; totalLossAmount += ((priceMap[pId] || 0) * qty);
        } else if (logType.includes("店頭販売")) {
          directSalesAmount += ((priceMap[pId] || 0) * qty); directSalesCount += 1; directSalesItems[itemName] = (directSalesItems[itemName] || 0) + qty;
        }
      }
    });
  }

  const statsArray = Object.keys(statsMap).map(pId => {
    const stat = statsMap[pId];
    return { productId: pId, name: nameMap[pId] || "不明", harvestQty: stat.harvestQty, lossQty: stat.lossQty, lossRate: stat.harvestQty > 0 ? Math.round((stat.lossQty / stat.harvestQty) * 100) : (stat.lossQty > 0 ? 100 : 0) };
  }).filter(s => s.harvestQty > 0 || s.lossQty > 0).sort((a, b) => b.lossRate - a.lossRate);

  return { totalLossAmount: totalLossAmount, stats: statsArray, directSalesAmount: directSalesAmount, directSalesCount: directSalesCount, directSalesItems: directSalesItems };
}

// 電話番号をそろえる（iPhoneの自動入力の「+81 80-…」を「080-…」にする）
function normalizePhone(value) {
  return String(value || "").trim().replace(/^\+81[\s-]?/, "0").replace(/[^\d-]/g, "");
}

// 1以上の整数かチェックして返す
function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(label + "は1以上の整数で入力してください。");
  return n;
}

function processAgencyDelivery(data) {
  const items = data.items;
  const agencyId = data.agencyId;
  const agencyName = data.agencyName;
  const deliveryDate = data.deliveryDate;
  const idPrefix = "AD" + new Date().getTime();
  if (!Array.isArray(items) || items.length === 0) throw new Error("納品する商品を選択してください。");

  items.forEach((item, index) => {
    const qty = positiveInt(item.qty, "納品数");
    SHEET_AGENCY_DELIVERIES.appendRow([
      idPrefix + "-" + index, deliveryDate, agencyId, agencyName, item.productId, item.productName,
      qty, 0, 0, 0, 0, 0, "納品済"
    ]);
    updateStockById(item.productId, -qty);
    SHEET_STOCK_LOGS.appendRow([ new Date(), item.productId, "委託納品", qty, agencyName + "へ納品(" + deliveryDate + ")", "" ]);
  });
  clearProductsCache();
}

function processCancelAgencyDelivery(data) {
  const rowIndex = Number(data.rowIndex);
  if (!(rowIndex >= 2)) throw new Error("対象データが見つかりません");
  const row = SHEET_AGENCY_DELIVERIES.getRange(rowIndex, 1, 1, 13).getValues()[0];
  const currentStatus = String(row[12] || "");

  if (currentStatus !== "納品済") throw new Error("すでに精算済か取消済のためキャンセルできません。");

  SHEET_AGENCY_DELIVERIES.getRange(rowIndex, 13).setValue("取消");

  const pId = String(row[4]);
  const qty = Number(row[6]);
  const aName = String(row[3]);

  updateStockById(pId, qty);
  SHEET_STOCK_LOGS.appendRow([ new Date(), pId, "納品取消", qty, aName + "の納品取消（在庫戻し）", "" ]);
  clearProductsCache();
}

function processAgencyInventory(data) {
  const targetId = data.deliveryId;
  const salesQty = Number(data.salesQty);
  const lossQty = Number(data.lossQty);
  if (!Number.isInteger(salesQty) || !Number.isInteger(lossQty) || salesQty < 0 || lossQty < 0) throw new Error("数量が正しくありません。");

  const deliveries = fetchAgencyDeliveries();
  const targetDeliv = deliveries.find(d => d.id === targetId);
  if (!targetDeliv) throw new Error("対象データが見つかりません");
  if (targetDeliv.status !== "納品済") throw new Error("すでに精算済か取消済です。");
  if (salesQty + lossQty !== targetDeliv.deliveryQty) throw new Error("「売れた数」と「ロス」の合計が納品数と一致しません。");

  const prices = fetchAgencyPrices();
  const priceRecord = prices.find(p => p.agencyId === targetDeliv.agencyId && p.productId === targetDeliv.productId);
  const storePriceTaxIn = priceRecord ? priceRecord.storePrice : 0;

  const agencies = fetchAgencies();
  const agency = agencies.find(a => a.id === targetDeliv.agencyId);
  const feeRate = agency ? agency.feeRate : 0;

  const storePriceExTax = Math.floor(storePriceTaxIn / 1.08);
  const salesAmountExTax = storePriceExTax * salesQty;
  const feeAmountExTax = Math.floor(salesAmountExTax * feeRate);
  const pureSalesExTax = salesAmountExTax - feeAmountExTax;

  // H〜M列をまとめて書き込む
  SHEET_AGENCY_DELIVERIES.getRange(targetDeliv.rowIndex, 8, 1, 6)
    .setValues([[salesQty, lossQty, salesAmountExTax, feeAmountExTax, pureSalesExTax, "精算済"]]);

  if (lossQty > 0) {
    SHEET_STOCK_LOGS.appendRow([ new Date(), targetDeliv.productId, "委託ロス", lossQty, targetDeliv.agencyName + "からの回収ロス", "" ]);
  }
}

function processCancelAgencyInventory(data) {
  const rowIndex = Number(data.rowIndex);
  if (!(rowIndex >= 2)) throw new Error("対象データが見つかりません");
  const row = SHEET_AGENCY_DELIVERIES.getRange(rowIndex, 1, 1, 13).getValues()[0];
  const currentStatus = String(row[12] || "");

  if (currentStatus !== "精算済") throw new Error("精算済のデータしか取り消せません。");

  const pId = String(row[4]);
  const lossQty = Number(row[8]);
  const aName = String(row[3]);

  // H〜M列をまとめて元に戻す
  SHEET_AGENCY_DELIVERIES.getRange(rowIndex, 8, 1, 6).setValues([[0, 0, 0, 0, 0, "納品済"]]);

  if (lossQty > 0) {
    SHEET_STOCK_LOGS.appendRow([ new Date(), pId, "精算取消", lossQty, aName + "の精算取消（ロス戻し）", "" ]);
  }
}

// ★配送料の計算（商品合計が基準額以上なら無料）
function calcShippingFee(method, subtotal) {
  if (method !== METHOD_DELIVERY) return 0;
  return subtotal >= DELIVERY.freeThreshold ? 0 : DELIVERY.fee;
}

// 日本時間の「今日」を yyyy-MM-dd で返す
function todayJst() {
  return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
}

// yyyy-MM-dd の曜日（0=日）
function weekdayOf(dateStr) {
  const p = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

function processNewOrder(data) {
  const method = data.deliveryMethod === METHOD_DELIVERY ? METHOD_DELIVERY : METHOD_PICKUP;
  const pickupDate = String(data.pickupDate || "");

  // --- 1. 日付チェック（明日以降のみ） ---
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new Error("日付が正しくありません。");
  if (pickupDate <= todayJst()) throw new Error("当日のご注文はお電話にてご相談ください。明日以降の日付をお選びください。");

  // --- 2. 配送の場合のチェック ---
  let address = "", phone = "", pickupTime = String(data.pickupTime || "");
  if (method === METHOD_DELIVERY) {
    if (DELIVERY.days.indexOf(weekdayOf(pickupDate)) === -1) throw new Error("配送は月曜日・火曜日のみ承っております。");
    const city = String(data.city || "");
    if (DELIVERY.areas.indexOf(city) === -1) throw new Error("配送エリア（庄内一円）外のため承れません。");
    address = city + String(data.addressDetail || "").trim();
    phone = normalizePhone(data.phone);
    if (!String(data.addressDetail || "").trim()) throw new Error("配送先のご住所を入力してください。");
    if (phone.replace(/-/g, "").length < 10) throw new Error("電話番号を正しく入力してください。");
    pickupTime = DELIVERY.time;
  }

  // --- 3. 金額と在庫はサーバー側で計算（画面から送られた金額は使わない） ---
  const prodValues = SHEET_PRODUCTS.getDataRange().getValues();
  const prodByName = {};
  for (let i = 1; i < prodValues.length; i++) {
    prodByName[String(prodValues[i][COL_PROD_NAME])] = { price: Number(prodValues[i][COL_PROD_PRICE] || 0), stock: Number(prodValues[i][COL_PROD_STOCK] || 0) };
  }

  const items = String(data.orderItems || "").split("\n").map(s => {
    const p = s.split(" × ");
    return p.length === 2 ? { name: p[0].trim(), qty: parseInt(p[1], 10) } : null;
  }).filter(it => it && it.qty > 0);
  if (items.length === 0) throw new Error("商品が選択されていません。");

  let subtotal = 0;
  const shortages = [];
  items.forEach(it => {
    const prod = prodByName[it.name];
    if (!prod) throw new Error("商品が見つかりません: " + it.name);
    if (prod.stock < it.qty) shortages.push(`${it.name}（残り${Math.max(0, prod.stock)}P）`);
    subtotal += prod.price * it.qty;
  });
  if (shortages.length > 0) throw new Error("申し訳ありません。在庫が足りなくなりました。\n" + shortages.join("\n"));

  const shippingFee = calcShippingFee(method, subtotal);
  const totalPrice = subtotal + shippingFee;
  const memo = String(data.memo || "なし");
  const storeName = String(data.storeName || "").trim().slice(0, 50);
  const orderId = newOrderId();

  // ★初回登録の情報（フルネーム・電話番号）があれば、LINEの表示名の代わりに使う
  const profile = findCustomer(data.userId);
  if (profile) {
    data.userName = profile.fullName;
    if (!phone && profile.phone) phone = profile.phone; // 店頭受取でも連絡先を残す
  }

  // --- 4. 書き込み ---
  SHEET_ORDERS.appendRow([
    data.userName,
    items.map(it => `${it.name} × ${it.qty}`).join("\n"),
    pickupDate,
    pickupTime,
    memo,
    totalPrice,
    new Date(),
    data.userId,
    "未対応",
    "",
    "",
    method,
    address,
    phone ? "'" + phone : "", // 先頭の0が消えないよう文字列で保存
    shippingFee,
    storeName,
    orderId,
    ""
  ]);

  items.forEach(it => updateStockByName(it.name, -it.qty));
  clearProductsCache();

  const order = {
    userName: data.userName, userId: data.userId, method: method,
    pickupDate: pickupDate, pickupTime: pickupTime,
    orderItems: items.map(it => `${it.name} × ${it.qty}`).join("\n"),
    memo: memo, address: address, phone: phone, storeName: storeName,
    subtotal: subtotal, shippingFee: shippingFee, totalPrice: totalPrice
  };
  sendLineNotification(order);

  if (LINE_GROUP_ID) {
    const isDelivery = method === METHOD_DELIVERY;
    const head = isDelivery ? "🚚【新規注文・配送】" : "🔔【新規注文・店頭受取】";
    const who = storeName ? `🏪 ${storeName}（${data.userName} 様）` : `👤 ${data.userName} 様`;
    const when = isDelivery
      ? `📅 ${jpDate(pickupDate)} ${timeLabel(pickupTime)}頃\n🏠 ${address}\n📞 ${phone}`
      : `📅 ${jpDate(pickupDate)} ${timeLabel(pickupTime)}`;
    const money = isDelivery
      ? `💰 ¥${totalPrice.toLocaleString()}（送料${shippingFee === 0 ? '無料' : '¥' + shippingFee.toLocaleString()}込）`
      : `💰 ¥${totalPrice.toLocaleString()}`;
    const memoLine = memo && memo !== "なし" ? `\n💬 ${memo}` : "";
    const groupMsg = `${head}\n${who}\n${when}\n\n${itemLines(order.orderItems)}\n\n${money}${memoLine}\n\n▶ 管理画面\n${ADMIN_URL}`;
    pushLineMessageToGroup(groupMsg);
  }

  return { orderId: orderId, totalPrice: totalPrice, shippingFee: shippingFee, subtotal: subtotal };
}

function weekdayLabel(dateStr) {
  return ["日", "月", "火", "水", "木", "金", "土"][weekdayOf(dateStr)];
}

/* ===== ★お客様の登録情報（初回だけ入力：フルネーム・電話番号・店舗名） ===== */
// Customers シート：A LINEユーザーID / B お名前 / C 電話番号 / D 店舗名 / E 登録日時 / F 更新日時
function customerSheet() {
  let sh = SS.getSheetByName("Customers");
  if (!sh) {
    sh = SS.insertSheet("Customers");
    sh.getRange(1, 1, 1, 6).setValues([["LINEユーザーID", "お名前", "電話番号", "店舗名", "登録日時", "更新日時"]]);
    sh.getRange("C:C").setNumberFormat("@"); // 電話番号の先頭の0を消さない
  }
  return sh;
}

function findCustomer(userId) {
  if (!userId) return null;
  const values = customerSheet().getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(userId)) {
      return { fullName: String(values[i][1] || ""), phone: String(values[i][2] || ""), storeName: String(values[i][3] || "") };
    }
  }
  return null;
}

function saveCustomer(data, verified) {
  if (!verified || !data.userId) throw new Error("LINEアプリから開き直してください（本人確認ができませんでした）。");
  const fullName = String(data.fullName || "").trim().slice(0, 30);
  const phone = normalizePhone(data.phone);
  const storeName = String(data.storeName || "").trim().slice(0, 50);
  if (!fullName) throw new Error("お名前を入力してください。");
  if (phone.replace(/-/g, "").length < 10) throw new Error("電話番号を正しく入力してください。");

  const sh = customerSheet();
  const values = sh.getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(data.userId)) {
      sh.getRange(i + 1, 2, 1, 3).setValues([[fullName, phone, storeName]]);
      sh.getRange(i + 1, 6).setValue(now);
      return { fullName: fullName, phone: phone, storeName: storeName };
    }
  }
  sh.appendRow([data.userId, fullName, phone, storeName, now, now]);
  return { fullName: fullName, phone: phone, storeName: storeName };
}

/* ===== ★お客様への前日リマインド（毎日17時） ===== */
function sendCustomerReminders() {
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), "Asia/Tokyo", "yyyy-MM-dd");
  fetchOrders().filter(o => o.pickupDate === tomorrow && (o.status === "未対応" || o.status === "準備完了") && o.userId).forEach(o => {
    const isDelivery = o.deliveryMethod === METHOD_DELIVERY;
    const items = o.itemsList.map(it => `・${it.name} × ${it.qty}`).join("\n");
    const msg = isDelivery
      ? `${o.userName}様\n\n明日、ご注文の商品をお届けします🚚\n\n📅 ${jpDate(o.pickupDate)} ${timeLabel(o.pickupTime)}頃\n🏠 ${o.address}\n\n${items}\n\n💴 お支払い：¥${o.totalPrice.toLocaleString()}（配達時に現金）\n\nご不在になる場合は、このトークでお知らせください。`
      : `${o.userName}様\n\n明日はご注文の受け取り日です🌱\n\n📅 ${jpDate(o.pickupDate)} ${timeLabel(o.pickupTime)}\n\n${items}\n\n💴 お支払い：¥${o.totalPrice.toLocaleString()}（お受け取り時に現金）\n\nご都合が悪くなった場合は、このトークでお知らせください。ご来店をお待ちしております。`;
    pushLine(o.userId, msg);
  });
}

// ★初回だけエディタから実行：前日リマインドを毎日17時に送る設定
function setupReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "sendCustomerReminders") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendCustomerReminders").timeBased().everyDays(1).atHour(17).inTimezone("Asia/Tokyo").create();
  Logger.log("前日リマインドを毎日17時に送る設定をしました");
}

/* ===== ★通知文の部品 ===== */
const ADMIN_URL = "https://n-sketch-r.github.io/nanairo-app/admin.html";

// "2026-09-29" → "9月29日(火)"
function jpDate(dateStr) {
  const p = String(dateStr).split("-").map(Number);
  if (p.length !== 3 || !p[1]) return String(dateStr);
  return `${p[1]}月${p[2]}日(${weekdayLabel(dateStr)})`;
}

// 前日の yyyy-MM-dd
function prevDay(dateStr) {
  const p = String(dateStr).split("-").map(Number);
  return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2] - 1)), "UTC", "yyyy-MM-dd");
}

// "11:00-12:00" → "11:00〜12:00"
function timeLabel(t) {
  return String(t || "").replace("-", "〜");
}

// "ロケット × 2\nデトロイト × 1" → "・ロケット × 2\n・デトロイト × 1"
function itemLines(itemsStr) {
  return String(itemsStr || "").split("\n").filter(s => s.trim()).map(s => "・" + s.trim()).join("\n");
}

function processCancelOrder(data) {
  const values = SHEET_ORDERS.getDataRange().getValues();
  const rowNum = findOrderRow(values, data.orderId);
  if (rowNum < 0) throw new Error("ご注文が見つかりませんでした。");
  const row = values[rowNum - 1];

  // ★本人以外の注文はキャンセルできないようにする
  if (!data.userId || String(row[7]) !== String(data.userId)) throw new Error("この注文はキャンセルできません。");
  const currentStatus = String(row[COL_ORD_STATUS] || "未対応");
  if (currentStatus !== "未対応") throw new Error("この注文はすでに処理が進んでいるためキャンセルできません。");
  // ★キャンセルも注文と同じく前日23:59まで（当日はすでに準備を始めているため）
  const rowPickup = row[2] instanceof Date ? Utilities.formatDate(row[2], "Asia/Tokyo", "yyyy-MM-dd") : String(row[2] || "").substring(0, 10).replace(/\//g, '-');
  if (rowPickup && rowPickup <= todayJst()) throw new Error("受取日（配送日）の前日を過ぎたため、システムからはキャンセルできません。");

  SHEET_ORDERS.getRange(rowNum, COL_ORD_STATUS + 1).setValue("キャンセル");

  const itemsStr = String(row[1] || "");
  const itemsList = itemsStr.split("\n").map(s => {
    const p = s.split(" × ");
    return p.length === 2 ? { name: p[0].trim(), qty: parseInt(p[1], 10) } : null;
  }).filter(Boolean);

  itemsList.forEach(item => { updateStockByName(item.name, item.qty); });
  clearProductsCache();

  const userName = String(row[0] || "");
  const pickupDateObj = row[2];
  const pickupTime = String(row[3] || "");
  let pickupDate = pickupDateObj instanceof Date ? Utilities.formatDate(pickupDateObj, "JST", "yyyy-MM-dd") : String(pickupDateObj || "").substring(0, 10).replace(/\//g, '-');

  const methodLabel = String(row[COL_ORD_METHOD] || METHOD_PICKUP) === METHOD_DELIVERY ? "配送" : "受取";
  sendLineCancelNotification(userName, data.userId, pickupDate, pickupTime, itemsStr, methodLabel);

  if (LINE_GROUP_ID) {
    const storeName = String(row[COL_ORD_STORE] || "");
    const who = storeName ? `🏪 ${storeName}（${userName} 様）` : `👤 ${userName} 様`;
    const cancelMsg = `❌【キャンセル・${methodLabel === "配送" ? "配送" : "店頭受取"}】\n${who}\n📅 ${jpDate(pickupDate)} ${timeLabel(pickupTime)}\n\n${itemLines(itemsStr)}\n\n※在庫は自動で戻しました。準備済みの分があれば店頭在庫に回してください。`;
    pushLineMessageToGroup(cancelMsg);
  }
}

function processStockAdjustment(data) {
  const amount = positiveInt(data.amount, "数量");
  let diff = 0; let typeLabel = "";
  if (data.type === 'add') { diff = amount; typeLabel = "収穫"; }
  else if (data.type === 'remove') { diff = -amount; typeLabel = "ロス"; }
  else if (data.type === 'sale') { diff = -amount; typeLabel = "店頭販売"; }
  else throw new Error("区分が正しくありません。");

  if (!updateStockById(data.productId, diff)) throw new Error("商品が見つかりません。");
  SHEET_STOCK_LOGS.appendRow([ new Date(), data.productId, typeLabel, amount, data.memo || "", "" ]);
  clearProductsCache();
}

function processBulkLoss(data) {
  clearProductsCache(); // 最新の在庫で計算する
  const products = fetchProducts();
  const memo = data.memo || "一括ロス";
  const now = new Date();

  products.forEach(p => {
    if (p.stock > 0) {
      updateStockById(p.id, -p.stock);
      SHEET_STOCK_LOGS.appendRow([ now, p.id, "ロス", p.stock, memo, "" ]);
    }
  });
  clearProductsCache();
}

function processCancelStockLog(data) {
  const rowIndex = Number(data.rowIndex);
  if (!(rowIndex >= 2)) throw new Error("対象の記録が見つかりません。");
  const row = SHEET_STOCK_LOGS.getRange(rowIndex, 1, 1, 6).getValues()[0];
  const currentStatus = String(row[5] || "");

  if (currentStatus === "取消") throw new Error("この記録はすでに取り消されています。");

  SHEET_STOCK_LOGS.getRange(rowIndex, 6).setValue("取消");

  const pId = String(row[1]);
  const typeLabel = String(row[2]);
  const amount = Number(row[3]);

  let diff = 0;
  if (typeLabel.includes("収穫")) diff = -amount;
  else if (typeLabel.includes("ロス") || typeLabel.includes("販売")) diff = amount;

  updateStockById(pId, diff);
  clearProductsCache();
}

function processStatusChange(data) {
  if (ORDER_STATUSES.indexOf(data.newStatus) === -1 || data.newStatus === "キャンセル") throw new Error("ステータスが正しくありません。");
  const values = SHEET_ORDERS.getDataRange().getValues();
  const rowNum = findOrderRow(values, data.orderId);
  if (rowNum < 0) throw new Error("注文が見つかりません。画面を更新してください。");
  if (String(values[rowNum - 1][COL_ORD_STATUS]) === "キャンセル") throw new Error("キャンセル済みの注文は変更できません。");
  SHEET_ORDERS.getRange(rowNum, COL_ORD_STATUS + 1).setValue(data.newStatus);
}

function processToggleCheck(data) {
  const cols = { senmu: COL_ORD_SENMU_CHECK, cafe: COL_ORD_CAFE_CHECK, paid: COL_ORD_PAID };
  if (!(data.role in cols)) throw new Error("確認の種類が正しくありません。");
  const values = SHEET_ORDERS.getDataRange().getValues();
  const rowNum = findOrderRow(values, data.orderId);
  if (rowNum < 0) throw new Error("注文が見つかりません。画面を更新してください。");
  SHEET_ORDERS.getRange(rowNum, cols[data.role] + 1).setValue(data.isChecked ? true : "");
}

// 在庫を増減する。商品が見つかれば true
function updateStockById(id, diff) {
  if (!id) return false;
  const data = SHEET_PRODUCTS.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COL_PROD_ID]) === String(id)) {
      const currentStock = Number(data[i][COL_PROD_STOCK]) || 0;
      SHEET_PRODUCTS.getRange(i + 1, COL_PROD_STOCK + 1).setValue(currentStock + diff);
      return true;
    }
  }
  return false;
}

function updateStockByName(name, diff) {
  if (!name) return false;
  const data = SHEET_PRODUCTS.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COL_PROD_NAME]) === String(name)) {
      const currentStock = Number(data[i][COL_PROD_STOCK]) || 0;
      SHEET_PRODUCTS.getRange(i + 1, COL_PROD_STOCK + 1).setValue(currentStock + diff);
      return true;
    }
  }
  return false;
}

// LINEにプッシュ送信する（トークン未設定なら送らずにログだけ残す）
function pushLine(to, text) {
  if (!LINE_TOKEN) { console.error("LINE_TOKEN が未設定のため送信できません"); return; }
  if (!to) return;
  try {
    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      "method": "post",
      "headers": { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
      "payload": JSON.stringify({ "to": to, "messages": [{ "type": "text", "text": text }] }),
      "muteHttpExceptions": true
    });
  } catch (e) { console.error("LINE送信エラー:", e); }
}

function sendLineNotification(data) {
  const isDelivery = data.method === METHOD_DELIVERY;
  const deadline = `${jpDate(prevDay(data.pickupDate))} 23:59`;
  const body = isDelivery
    ? `🚚 お届け日時\n${jpDate(data.pickupDate)} ${timeLabel(data.pickupTime)}頃\n\n🏠 お届け先\n${data.storeName ? data.storeName + "\n" : ""}${data.address}`
    : `📅 お受け取り日時\n${jpDate(data.pickupDate)} ${timeLabel(data.pickupTime)}\n店頭にてお渡しします。`;
  const money = isDelivery
    ? `商品小計　¥${data.subtotal.toLocaleString()}\n送料　　　${data.shippingFee === 0 ? '無料' : '¥' + data.shippingFee.toLocaleString()}\n合計　　　¥${data.totalPrice.toLocaleString()}（税込）`
    : `合計　¥${data.totalPrice.toLocaleString()}（税込）`;
  const pay = isDelivery ? "配達時に現金でお支払いください。" : "お受け取り時に現金でお支払いください。";
  const msg = `${data.userName}様\n\nご注文ありがとうございます🌱\n以下の内容で承りました。\n\n${body}\n\n🛒 ご注文内容\n${itemLines(data.orderItems)}\n\n${money}\n💴 ${pay}\n\n――――――――――\nキャンセルは ${deadline} まで、注文画面の「履歴・キャンセル」からできます。それ以降の変更は、このトークでお知らせください。${isDelivery ? "\n\n配送日時の調整などで、このトークからご連絡する場合があります。" : "\n\nご来店をお待ちしております。"}`;
  pushLine(data.userId, msg);
}


function sendLineCancelNotification(userName, userId, pickupDate, pickupTime, orderItems, methodLabel) {
  const label = methodLabel === "配送" ? "お届け予定" : "お受け取り予定";
  const msg = `${userName}様\n\n下記のご注文のキャンセルを承りました。\n\n📅 ${label}\n${jpDate(pickupDate)} ${timeLabel(pickupTime)}\n\n${itemLines(orderItems)}\n\nまたのご利用をお待ちしております🌱`;
  pushLine(userId, msg);
}

function pushLineMessageToGroup(msg) {
  if (!LINE_GROUP_ID) return;
  pushLine(LINE_GROUP_ID, msg);
}

function sendMorningReminder() {
  if (!LINE_GROUP_ID) return;

  const todayStr = Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd");
  const allOrders = fetchOrders();

  const todaysOrders = allOrders.filter(o =>
    o.pickupDate === todayStr &&
    (o.status === "未対応" || o.status === "準備完了")
  );

  if (todaysOrders.length === 0) {
    return;
  }

  const deliveryCount = todaysOrders.filter(o => o.deliveryMethod === METHOD_DELIVERY).length;
  const pickupCount = todaysOrders.length - deliveryCount;
  let msg = `おはようございます！☀️\n本日の予定は【 ${todaysOrders.length} 件 】です。\n（🏪店頭受取 ${pickupCount}件 ／ 🚚配送 ${deliveryCount}件）\n\n`;

  // 店頭受取 → 配送 の順に並べる
  todaysOrders.sort((a, b) => (a.deliveryMethod === METHOD_DELIVERY) - (b.deliveryMethod === METHOD_DELIVERY));
  todaysOrders.forEach((o, i) => {
    const isDelivery = o.deliveryMethod === METHOD_DELIVERY;
    msg += `■ ${i+1}件目 ${isDelivery ? '🚚配送' : '🏪店頭'} (${o.pickupTime})\n`;
    msg += o.storeName ? `🏪 ${o.storeName}（${o.userName} 様）\n` : `👤 ${o.userName} 様\n`;
    if (isDelivery) {
      msg += `🏠 ${o.address}\n📞 ${o.phone}\n`;
    }
    const items = o.itemsList.map(item => `${item.name}×${item.qty}`).join(", ");
    msg += `📦 ${items}\n`;
    if (o.memo && o.memo !== "なし") {
      msg += `💬 備考: ${o.memo}\n`;
    }
    msg += `\n`;
  });

  msg += `本日もよろしくお願いします！`;

  pushLineMessageToGroup(msg);
}

function setupMorningTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendMorningReminder') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('sendMorningReminder')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  Logger.log("朝の通知トリガーをセットしました！");
}

/* =====================================================================
 * ★分析エンジン（管理画面「分析」タブ用）
 *  売上の基準日：LINE注文＝受取日／店頭販売＝記録日／委託＝納品日（精算済のみ）
 *  金額はすべて税込。LINE注文の売上は商品代のみ（配送料は別集計）
 * ===================================================================== */
function buildInsights(allOrders, startMonth, endMonth) {
  const tz = "Asia/Tokyo";
  const today = todayJst();
  if (!startMonth) startMonth = today.substring(0, 7);
  if (!endMonth) endMonth = startMonth;

  // --- 期間の計算（前期間＝同じ長さの直前期間） ---
  const monthIndex = m => { const p = m.split("-").map(Number); return p[0] * 12 + (p[1] - 1); };
  const monthStr = i => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`;
  const sIdx = monthIndex(startMonth), eIdx = monthIndex(endMonth);
  const len = eIdx - sIdx + 1;
  const prevStart = monthStr(sIdx - len), prevEnd = monthStr(sIdx - 1);
  const periodOf = d => { const m = String(d).substring(0, 7); if (m >= startMonth && m <= endMonth) return "cur"; if (m >= prevStart && m <= prevEnd) return "prev"; return null; };
  // 経過日数（当月が途中なら今日まで）で週平均を出す
  const periodStartDate = startMonth + "-01";
  const lastDayOfEnd = Utilities.formatDate(new Date(Math.floor(eIdx / 12), eIdx % 12 + 1, 0), tz, "yyyy-MM-dd");
  const periodEndDate = lastDayOfEnd < today ? lastDayOfEnd : today;
  const days = Math.max(1, Math.round((new Date(periodEndDate) - new Date(periodStartDate)) / 86400000) + 1);
  const weeks = days / 7;

  // --- 商品マスタ ---
  const products = fetchProducts();
  const prod = {}; const idByName = {};
  products.forEach(p => {
    idByName[p.name] = p.id;
    prod[p.id] = { id: p.id, name: p.name, price: p.price, stock: p.stock, harvest: 0, soldLine: 0, soldStore: 0, soldAgency: 0, loss: 0, lossAmount: 0, sales: 0, prevSold: 0, prevSales: 0 };
  });

  // --- 集計の器 ---
  const emptyTotals = () => ({ line: 0, store: 0, agency: 0, shipping: 0, qty: 0, lineOrders: 0, storeTx: 0, delivery: 0, pickup: 0, harvest: 0, loss: 0, lossAmount: 0 });
  const T = { cur: emptyTotals(), prev: emptyTotals() };
  const trendStart = eIdx - 11; // 直近12か月
  const monthly = {};
  for (let i = trendStart; i <= eIdx; i++) monthly[monthStr(i)] = { month: monthStr(i), line: 0, store: 0, agency: 0, lossAmount: 0, harvest: 0, sold: 0 };
  const weekday = [0, 1, 2, 3, 4, 5, 6].map(d => ({ day: d, sales: 0, qty: 0 }));
  const dowOf = ds => { const p = String(ds).substring(0, 10).split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); };

  // --- ① LINE注文 ---
  const customers = {};
  allOrders.forEach(o => {
    if (o.status === "キャンセル" || !o.pickupDate) return;
    const date = o.pickupDate;
    const goods = Number(o.totalPrice || 0) - Number(o.shippingFee || 0);
    const qty = o.itemsList.reduce((a, it) => a + (it.qty || 0), 0);
    const m = date.substring(0, 7);
    if (monthly[m]) { monthly[m].line += goods; monthly[m].sold += qty; }

    // 顧客（全期間）
    const cid = o.userId || o.userName;
    if (!customers[cid]) customers[cid] = { name: o.storeName || o.userName, userName: o.userName, first: date, last: date, orders: 0, spend: 0, dates: [] };
    const c = customers[cid];
    if (o.storeName) c.name = o.storeName;
    if (date < c.first) c.first = date;
    if (date > c.last) c.last = date;
    c.orders++; c.spend += goods; c.dates.push(date);

    const per = periodOf(date);
    if (!per) return;
    const t = T[per];
    t.line += goods; t.qty += qty; t.lineOrders++; t.shipping += Number(o.shippingFee || 0);
    if (o.deliveryMethod === METHOD_DELIVERY) t.delivery++; else t.pickup++;
    o.itemsList.forEach(it => {
      const p = prod[idByName[it.name]]; if (!p) return;
      if (per === "cur") { p.soldLine += it.qty; p.sales += p.price * it.qty; }
      else { p.prevSold += it.qty; p.prevSales += p.price * it.qty; }
    });
    if (per === "cur") { weekday[dowOf(date)].sales += goods; weekday[dowOf(date)].qty += qty; }
  });

  // --- ② 在庫ログ（収穫・ロス・店頭販売） ---
  const logs = SHEET_STOCK_LOGS.getDataRange().getValues();
  const storeTxKeys = { cur: {}, prev: {} }; // 同じ分に記録した店頭販売は1回の会計とみなす
  for (let i = 1; i < logs.length; i++) {
    const r = logs[i];
    if (String(r[5] || "") === "取消") continue;
    const dt = r[0] instanceof Date ? Utilities.formatDate(r[0], tz, "yyyy-MM-dd HH:mm") : String(r[0] || "").replace(/\//g, "-");
    const date = dt.substring(0, 10); const m = date.substring(0, 7);
    const p = prod[String(r[1] || "")]; if (!p) continue;
    const type = String(r[2] || ""); const qty = Number(r[3] || 0);
    const per = periodOf(date);
    const isHarvest = type.indexOf("収穫") > -1 || type.indexOf("追加") > -1;
    const isLoss = (type === "ロス" || type.indexOf("破棄") > -1); // 委託ロスは納品データ側で数える
    const isStore = type.indexOf("店頭販売") > -1;
    if (monthly[m]) {
      if (isHarvest) monthly[m].harvest += qty;
      if (isLoss) monthly[m].lossAmount += p.price * qty;
      if (isStore) { monthly[m].store += p.price * qty; monthly[m].sold += qty; }
    }
    if (!per) continue;
    const t = T[per];
    if (isHarvest) { t.harvest += qty; if (per === "cur") p.harvest += qty; }
    else if (isLoss) { t.loss += qty; t.lossAmount += p.price * qty; if (per === "cur") { p.loss += qty; p.lossAmount += p.price * qty; } }
    else if (isStore) {
      t.store += p.price * qty; t.qty += qty; storeTxKeys[per][dt.substring(0, 16)] = true;
      if (per === "cur") { p.soldStore += qty; p.sales += p.price * qty; weekday[dowOf(date)].sales += p.price * qty; weekday[dowOf(date)].qty += qty; }
      else { p.prevSold += qty; p.prevSales += p.price * qty; }
    }
  }
  T.cur.storeTx = Object.keys(storeTxKeys.cur).length;
  T.prev.storeTx = Object.keys(storeTxKeys.prev).length;

  // --- ③ 委託（精算済） ---
  fetchAgencyDeliveries().forEach(d => {
    if (d.status !== "精算済") return;
    const amount = Math.floor(d.pureSalesExTax * 1.08);
    const m = d.date.substring(0, 7);
    const p = prod[d.productId];
    if (monthly[m]) { monthly[m].agency += amount; monthly[m].sold += d.salesQty; if (p) monthly[m].lossAmount += p.price * d.lossQty; }
    const per = periodOf(d.date); if (!per) return;
    const t = T[per];
    t.agency += amount; t.qty += d.salesQty; t.loss += d.lossQty;
    if (p) {
      t.lossAmount += p.price * d.lossQty;
      if (per === "cur") { p.soldAgency += d.salesQty; p.sales += amount; p.loss += d.lossQty; p.lossAmount += p.price * d.lossQty; }
      else { p.prevSold += d.salesQty; p.prevSales += amount; }
    }
  });

  // --- ④ 商品ごとの指標と「推奨収穫量」 ---
  const productRows = Object.keys(prod).map(id => {
    const p = prod[id];
    const sold = p.soldLine + p.soldStore + p.soldAgency;
    const sellThrough = p.harvest > 0 ? Math.round(sold / p.harvest * 100) : null;
    const lossRate = p.harvest > 0 ? Math.round(p.loss / p.harvest * 100) : null;
    const weeklySold = sold / weeks;
    const weeklyHarvest = p.harvest / weeks;
    // 推奨＝週平均販売数 × 1.15（欠品を防ぐ15%の余裕）。販売実績がない商品は0
    const suggested = sold > 0 ? Math.ceil(weeklySold * 1.15) : 0;
    let action = "keep";
    if (p.harvest === 0 && sold === 0) action = "none";
    else if (weeklyHarvest - suggested >= 0.5 && (lossRate || 0) >= 30) action = "reduce";
    else if (suggested - weeklyHarvest >= 0.5 && (sellThrough || 0) >= 85) action = "increase";
    return {
      id: p.id, name: p.name, price: p.price, stock: p.stock,
      harvest: p.harvest, sold: sold, soldLine: p.soldLine, soldStore: p.soldStore, soldAgency: p.soldAgency,
      loss: p.loss, lossAmount: p.lossAmount, sales: p.sales, prevSales: p.prevSales, prevSold: p.prevSold,
      sellThrough: sellThrough, lossRate: lossRate,
      weeklySold: Math.round(weeklySold * 10) / 10, weeklyHarvest: Math.round(weeklyHarvest * 10) / 10,
      suggestedWeekly: suggested, action: action
    };
  }).filter(r => r.action !== "none").sort((a, b) => b.sales - a.sales);

  // --- ⑤ 顧客分析（LINE） ---
  const custList = Object.keys(customers).map(k => {
    const c = customers[k];
    c.dates.sort();
    let gap = null;
    if (c.dates.length >= 2) {
      const first = new Date(c.dates[0]), last = new Date(c.dates[c.dates.length - 1]);
      gap = Math.round((last - first) / 86400000 / (c.dates.length - 1));
    }
    const daysSince = Math.round((new Date(today) - new Date(c.last)) / 86400000);
    return { id: k, name: c.name, userName: c.userName, first: c.first, last: c.last, orders: c.orders, spend: c.spend, avgGapDays: gap, daysSince: daysSince };
  });
  const activeIds = {}; const newIds = {};
  allOrders.forEach(o => {
    if (o.status === "キャンセル" || !o.pickupDate || periodOf(o.pickupDate) !== "cur") return;
    const cid = o.userId || o.userName; activeIds[cid] = true;
    if (String(customers[cid].first).substring(0, 7) >= startMonth) newIds[cid] = true;
  });
  const activeCount = Object.keys(activeIds).length;
  const newCount = Object.keys(newIds).length;
  const repeaters = custList.filter(c => c.orders >= 2).length;
  // 要フォロー：いつもの注文間隔の2倍 or 30日以上 注文がないお客様
  const followUp = custList.filter(c => {
    const threshold = c.avgGapDays ? Math.max(21, c.avgGapDays * 2) : 30;
    return c.daysSince >= threshold && c.last <= today;
  }).sort((a, b) => b.spend - a.spend).slice(0, 10);

  // --- まとめ ---
  const sum = t => t.line + t.store + t.agency;
  const pack = t => ({
    sales: sum(t), line: t.line, store: t.store, agency: t.agency, shipping: t.shipping,
    qty: t.qty, lineOrders: t.lineOrders, storeTx: t.storeTx, delivery: t.delivery, pickup: t.pickup,
    harvest: t.harvest, loss: t.loss, lossAmount: t.lossAmount,
    sellThrough: t.harvest > 0 ? Math.round(t.qty / t.harvest * 100) : null,
    lossRate: t.harvest > 0 ? Math.round(t.loss / t.harvest * 100) : null,
    avgLineOrder: t.lineOrders > 0 ? Math.round(t.line / t.lineOrders) : 0
  });

  return {
    period: { start: startMonth, end: endMonth, prevStart: prevStart, prevEnd: prevEnd, days: days, today: today },
    current: pack(T.cur), previous: pack(T.prev),
    monthly: Object.keys(monthly).sort().map(k => monthly[k]),
    weekday: weekday,
    products: productRows,
    customers: {
      total: custList.length, active: activeCount, newCount: newCount,
      repeaters: repeaters, repeatRate: custList.length > 0 ? Math.round(repeaters / custList.length * 100) : 0,
      followUp: followUp
    }
  };
}
