// server/db/queries/inventory.js
//
// Three resource tables (suppliers, purchase_orders + items,
// stock_movements) and a derived view: products with stock <= low_stock
// (low-stock alerts).
//
// Authorization: SUPPLIER / PO / STOCK_MOVEMENT write operations are
// admin-only (gated in routes). Reads are scoped by storeType/storeId;
// SUPER_OWNER passes through.

const { query, withTransaction } = require("../pool");

const SUPPLIER_COLUMNS =
  "id, name, phone, email, address, gstin, notes, _store_type, _store_id, _user_email, created_at, updated_at";

const PO_COLUMNS =
  "id, po_number, supplier_id, supplier_name, status, total_amount, notes, expected_at, received_at, _store_type, _store_id, _user_email, created_at, updated_at";

const PO_ITEM_COLUMNS =
  "id, purchase_order_id, product_id, product_name, quantity, unit_price, received_quantity";

const STOCK_MOVE_COLUMNS =
  "id, product_id, product_name, type, quantity, reason, purchase_order_id, created_by, _store_type, _store_id, created_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToSupplier = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    name: row.name || null,
    phone: row.phone || null,
    email: row.email || null,
    address: row.address || null,
    gstin: row.gstin || null,
    notes: row.notes || null,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const rowToPurchaseOrder = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    poNumber: row.po_number || null,
    supplierId: row.supplier_id != null ? Number(row.supplier_id) : row.supplier_id,
    supplierName: row.supplier_name || null,
    status: row.status || "draft",
    totalAmount: toNumber(row.total_amount) ?? 0,
    notes: row.notes || null,
    expectedAt: row.expected_at || null,
    receivedAt: row.received_at || null,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const rowToPoItem = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    purchaseOrderId: row.purchase_order_id != null ? Number(row.purchase_order_id) : row.purchase_order_id,
    productId: row.product_id != null ? Number(row.product_id) : row.product_id,
    productName: row.product_name || null,
    quantity: toNumber(row.quantity) ?? 0,
    unitPrice: toNumber(row.unit_price) ?? 0,
    receivedQuantity: toNumber(row.received_quantity) ?? 0,
  };
};

const rowToStockMovement = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    productId: row.product_id != null ? Number(row.product_id) : row.product_id,
    productName: row.product_name || null,
    type: row.type || null,
    quantity: toNumber(row.quantity) ?? 0,
    reason: row.reason || null,
    purchaseOrderId: row.purchase_order_id != null ? Number(row.purchase_order_id) : row.purchase_order_id,
    createdBy: row.created_by != null ? Number(row.created_by) : row.created_by,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    createdAt: row.created_at || null,
  };
};

// === Scope helpers =========================================================

const buildStoreWhere = (scope, tableAlias = "") => {
  const alias = tableAlias ? `${tableAlias}.` : "";
  const conds = [];
  const params = [];
  if (scope.storeType) {
    conds.push(`${alias}_store_type = ?`);
    params.push(String(scope.storeType));
  }
  if (scope.storeId) {
    conds.push(`${alias}_store_id = ?`);
    params.push(String(scope.storeId));
  }
  return {
    sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
};

// === Suppliers =============================================================

const listSuppliers = async (scope) => {
  const w = buildStoreWhere(scope);
  const rows = await query(
    `SELECT ${SUPPLIER_COLUMNS} FROM suppliers ${w.sql} ORDER BY name ASC, id DESC`,
    w.params
  );
  return rows[0].map(rowToSupplier);
};

const findSupplierById = async (id) => {
  const rows = await query(
    `SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToSupplier(rows[0][0]);
};

const createSupplier = async (item, scope) => {
  if (!item || !item.name) return null;
  const result = await query(
    `INSERT INTO suppliers (name, phone, email, address, gstin, notes, _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      item.name,
      item.phone || null,
      item.email || null,
      item.address || null,
      item.gstin || null,
      item.notes || null,
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ]
  );
  return findSupplierById(result[0].insertId);
};

const updateSupplier = async (id, patch) => {
  const allowed = ["name", "phone", "email", "address", "gstin", "notes"];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    sets.push(`\`${k}\` = ?`);
    params.push(patch[k]);
  }
  if (!sets.length) {
    await query("UPDATE suppliers SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findSupplierById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = ?`, params);
  return findSupplierById(id);
};

const deleteSupplier = async (id) => {
  const result = await query("DELETE FROM suppliers WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

// === Purchase Orders =======================================================

const listPurchaseOrders = async (scope, filters = {}) => {
  const w = buildStoreWhere(scope);
  const conds = [...w.sql ? [w.sql.replace(/^WHERE /, "")] : []];
  const params = [...w.params];
  if (filters.status) {
    conds.push("status = ?");
    params.push(String(filters.status));
  }
  if (filters.supplierId) {
    conds.push("supplier_id = ?");
    params.push(filters.supplierId);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await query(
    `SELECT ${PO_COLUMNS} FROM purchase_orders ${where}
     ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows[0].map(rowToPurchaseOrder);
};

const findPurchaseOrderById = async (id) => {
  const rows = await query(
    `SELECT ${PO_COLUMNS} FROM purchase_orders WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToPurchaseOrder(rows[0][0]);
};

const listPoItems = async (poId) => {
  const rows = await query(
    `SELECT ${PO_ITEM_COLUMNS} FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY id ASC`,
    [poId]
  );
  return rows[0].map(rowToPoItem);
};

const createPurchaseOrder = async (item, scope) => {
  if (!item || !item.poNumber) return null;
  const items = Array.isArray(item.items) ? item.items : [];
  let totalAmount = 0;
  for (const it of items) {
    totalAmount += (Number(it?.quantity) || 0) * (Number(it?.unitPrice) || 0);
  }
  const id = await withTransaction(async (conn) => {
    const [res] = await conn.execute(
      `INSERT INTO purchase_orders (po_number, supplier_id, supplier_name, status, total_amount, notes, expected_at, _store_type, _store_id, _user_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      [
        item.poNumber,
        item.supplierId || null,
        item.supplierName || null,
        item.status || "draft",
        totalAmount,
        item.notes || null,
        item.expectedAt || null,
        scope.storeType || null,
        scope.storeId || null,
        scope.email || null,
      ]
    );
    const poId = res.insertId;
    for (const it of items) {
      await conn.execute(
        `INSERT INTO purchase_order_items (purchase_order_id, product_id, product_name, quantity, unit_price, received_quantity)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [poId, it.productId || null, it.productName || "", Number(it?.quantity) || 0, Number(it?.unitPrice) || 0]
      );
    }
    return poId;
  });
  return findPurchaseOrderById(id);
};

const updatePurchaseOrder = async (id, patch) => {
  const allowed = ["po_number", "supplier_id", "supplier_name", "status", "total_amount", "notes", "expected_at", "received_at"];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    sets.push(`\`${k}\` = ?`);
    params.push(patch[k]);
  }
  if (!sets.length) {
    await query("UPDATE purchase_orders SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findPurchaseOrderById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE purchase_orders SET ${sets.join(", ")} WHERE id = ?`, params);
  return findPurchaseOrderById(id);
};

const deletePurchaseOrder = async (id) => {
  const result = await query("DELETE FROM purchase_orders WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

// receivePurchaseOrder: transition draft|sent -> received, stamp received_at,
// and append one stock_movement (type='in') per item, plus bump products.stock.
// Idempotent — re-receiving returns the PO as-is.
const receivePurchaseOrder = async (id) => {
  const po = await findPurchaseOrderById(id);
  if (!po) return null;
  if (po.status === "received") return po;

  await withTransaction(async (conn) => {
    await conn.execute(
      `UPDATE purchase_orders SET status='received', received_at=NOW(3), updated_at=NOW(3) WHERE id=?`,
      [id]
    );
    const [items] = await conn.execute(
      `SELECT id, product_id, product_name, quantity, unit_price, received_quantity
       FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY id ASC`,
      [id]
    );
    for (const it of items) {
      const qty = Number(it.quantity) || 0;
      const remaining = qty - (Number(it.received_quantity) || 0);
      if (remaining <= 0) continue;
      // Mark received.
      await conn.execute(
        `UPDATE purchase_order_items SET received_quantity = ? WHERE id = ?`,
        [qty, it.id]
      );
      // Append stock movement.
      await conn.execute(
        `INSERT INTO stock_movements (product_id, product_name, type, quantity, reason, purchase_order_id, _store_type, _store_id, created_at)
         VALUES (?, ?, 'in', ?, ?, ?, ?, ?, NOW(3))`,
        [it.product_id || null, it.product_name || "", remaining, `PO ${po.poNumber}`, id, po._storeType || null, po._storeId || null]
      );
      // Bump products.stock if the product exists in the same store.
      if (it.product_id) {
        await conn.execute(
          `UPDATE products SET stock = stock + ?, updated_at = NOW(3)
           WHERE id = ? AND _store_type = ? AND _store_id = ?`,
          [remaining, it.product_id, po._storeType || "", po._storeId || ""]
        );
      }
    }
  });

  return findPurchaseOrderById(id);
};

// === Stock Movements =======================================================

const listStockMovements = async (scope, filters = {}) => {
  const w = buildStoreWhere(scope);
  const conds = [...w.sql ? [w.sql.replace(/^WHERE /, "")] : []];
  const params = [...w.params];
  if (filters.productId) {
    conds.push("product_id = ?");
    params.push(filters.productId);
  }
  if (filters.type) {
    conds.push("type = ?");
    params.push(String(filters.type));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await query(
    `SELECT ${STOCK_MOVE_COLUMNS} FROM stock_movements ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT 500`,
    params
  );
  return rows[0].map(rowToStockMovement);
};

const createStockMovement = async (item, scope) => {
  if (!item || !item.productId || !item.type) return null;
  if (!["in", "out", "adjustment"].includes(String(item.type))) return null;
  const qty = Number(item.quantity) || 0;
  if (qty <= 0) return null;

  const result = await query(
    `INSERT INTO stock_movements (product_id, product_name, type, quantity, reason, created_by, _store_type, _store_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [
      item.productId,
      item.productName || "",
      item.type,
      qty,
      item.reason || null,
      item.createdBy || null,
      scope.storeType || null,
      scope.storeId || null,
    ]
  );

  // Bump product stock: in adds, out subtracts, adjustment applies a delta
  // (qty may be negative).
  if (item.type === "in") {
    await query(
      `UPDATE products SET stock = stock + ?, updated_at = NOW(3) WHERE id = ?`,
      [qty, item.productId]
    );
  } else if (item.type === "out") {
    await query(
      `UPDATE products SET stock = stock - ?, updated_at = NOW(3) WHERE id = ?`,
      [qty, item.productId]
    );
  } else if (item.type === "adjustment") {
    // Adjustment's sign tells us which way to move stock.
    await query(
      `UPDATE products SET stock = stock + ?, updated_at = NOW(3) WHERE id = ?`,
      [qty, item.productId]
    );
  }

  return findStockMovementById(result[0].insertId);
};

const findStockMovementById = async (id) => {
  const rows = await query(
    `SELECT ${STOCK_MOVE_COLUMNS} FROM stock_movements WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToStockMovement(rows[0][0]);
};

// === Low-stock alerts ======================================================

const lowStockAlerts = async (scope) => {
  const w = buildStoreWhere(scope);
  const rows = await query(
    `SELECT id, name, stock, low_stock, _store_type, _store_id, category
     FROM products
     ${w.sql ? w.sql + " AND " : "WHERE "} low_stock > 0 AND stock <= low_stock
     ORDER BY (stock - low_stock) ASC, name ASC
     LIMIT 200`,
    w.params
  );
  return rows[0].map((r) => ({
    id: Number(r.id),
    name: r.name,
    stock: toNumber(r.stock) ?? 0,
    lowStock: toNumber(r.low_stock) ?? 0,
    deficit: (toNumber(r.low_stock) ?? 0) - (toNumber(r.stock) ?? 0),
    category: r.category || null,
    _storeType: r._store_type || null,
    _storeId: r._store_id || null,
  }));
};

module.exports = {
  // suppliers
  listSuppliers,
  findSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  // purchase orders
  listPurchaseOrders,
  findPurchaseOrderById,
  listPoItems,
  createPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
  receivePurchaseOrder,
  // stock movements
  listStockMovements,
  createStockMovement,
  findStockMovementById,
  // low stock
  lowStockAlerts,
};