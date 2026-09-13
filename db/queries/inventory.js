// server/db/queries/inventory.js
//
// MySQL queries for suppliers, purchase orders, stock movements, and
// low-stock alerts. Every read/write accepts a store scope so inventory
// records cannot leak across tenants.

const { query, withTransaction } = require("../pool");

const SUPPLIER_COLUMNS =
  "id, name, phone, email, address, gstin, notes, _store_type, _store_id, _user_email, created_at, updated_at";
const PO_COLUMNS =
  "id, po_number, supplier_id, supplier_name, status, total_amount, notes, expected_at, received_at, _store_type, _store_id, _user_email, created_at, updated_at";
const PO_ITEM_COLUMNS =
  "id, purchase_order_id, catalog_type, catalog_id, product_id, product_name, quantity, unit_price, received_quantity";
const STOCK_MOVE_COLUMNS =
  "id, product_id, product_name, type, quantity, reason, purchase_order_id, created_by, _store_type, _store_id, created_at";

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const rowToSupplier = (row) =>
  row
    ? {
        id: Number(row.id),
        name: row.name || "",
        phone: row.phone || "",
        email: row.email || "",
        address: row.address || "",
        gstin: row.gstin || "",
        notes: row.notes || "",
        _storeType: row._store_type || null,
        _storeId: row._store_id || null,
        _userEmail: row._user_email || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
      }
    : null;

const rowToPurchaseOrder = (row) =>
  row
    ? {
        id: Number(row.id),
        poNumber: row.po_number || "",
        supplierId: row.supplier_id == null ? null : Number(row.supplier_id),
        supplierName: row.supplier_name || "",
        status: row.status || "draft",
        totalAmount: toNumber(row.total_amount) ?? 0,
        notes: row.notes || "",
        expectedAt: row.expected_at || null,
        receivedAt: row.received_at || null,
        _storeType: row._store_type || null,
        _storeId: row._store_id || null,
        _userEmail: row._user_email || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
      }
    : null;

const rowToPoItem = (row) =>
  row
    ? {
        id: Number(row.id),
        purchaseOrderId: Number(row.purchase_order_id),
        catalogType: row.catalog_type === "service" ? "service" : "product",
        catalogId:
          row.catalog_id != null
            ? Number(row.catalog_id)
            : row.product_id == null
              ? null
              : Number(row.product_id),
        productId: row.product_id == null ? null : Number(row.product_id),
        productName: row.product_name || "",
        quantity: toNumber(row.quantity) ?? 0,
        unitPrice: toNumber(row.unit_price) ?? 0,
        receivedQuantity: toNumber(row.received_quantity) ?? 0,
      }
    : null;

const rowToStockMovement = (row) =>
  row
    ? {
        id: Number(row.id),
        productId: row.product_id == null ? null : Number(row.product_id),
        productName: row.product_name || "",
        type: row.type || "",
        quantity: toNumber(row.quantity) ?? 0,
        reason: row.reason || "",
        purchaseOrderId: row.purchase_order_id == null ? null : Number(row.purchase_order_id),
        createdBy: row.created_by == null ? null : Number(row.created_by),
        _storeType: row._store_type || null,
        _storeId: row._store_id || null,
        createdAt: row.created_at || null,
      }
    : null;

const buildStoreWhere = (scope = {}, alias = "") => {
  const prefix = alias ? `${alias}.` : "";
  const conditions = [];
  const params = [];
  if (scope.storeType) {
    conditions.push(`${prefix}_store_type = ?`);
    params.push(String(scope.storeType));
  }
  if (scope.storeId) {
    conditions.push(`${prefix}_store_id = ?`);
    params.push(String(scope.storeId));
  }
  return {
    sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
};

const scopedIdWhere = (scope, id, column = "id") => {
  const where = buildStoreWhere(scope);
  return {
    sql: `WHERE ${column} = ?${where.sql ? ` AND ${where.sql.replace(/^WHERE /, "")}` : ""}`,
    params: [id, ...where.params],
  };
};

const normalizePoItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one purchase-order line is required");
  }
  return items.map((item) => {
    const catalogType = item?.catalogType === "service" ? "service" : "product";
    const catalogId = item?.catalogId ?? item?.productId;
    const numericCatalogId = catalogId == null || catalogId === "" ? null : Number(catalogId);
    const productId = catalogType === "product" ? numericCatalogId : null;
    const productName = String(item?.productName || item?.name || "").trim();
    const quantity = Number(item?.quantity ?? item?.qty);
    const unitPrice = Number(item?.unitPrice ?? item?.unitCost);
    if (!productName && !Number.isFinite(numericCatalogId)) throw new Error("Each PO line needs a catalog item");
    if (!Number.isFinite(numericCatalogId) || numericCatalogId <= 0) throw new Error("Each PO line needs a valid catalog item");
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("PO quantities must be greater than zero");
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("PO unit prices must be non-negative");
    return { catalogType, catalogId: numericCatalogId, productId, productName, quantity, unitPrice };
  });
};

const totalForItems = (items) => items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);

const assertCatalogItemsInScope = async (items, scope) => {
  for (const item of items) {
    const table = item.catalogType === "service" ? "services" : "products";
    const [rows] = await query(
      `SELECT id FROM ${table} WHERE id = ? AND _store_type = ? AND _store_id = ? LIMIT 1`,
      [item.catalogId, scope.storeType || "", scope.storeId || ""]
    );
    if (!rows.length) throw new Error(`${item.catalogType === "service" ? "Service" : "Product"} not found in this store`);
  }
};

// === Suppliers ==============================================================

const listSuppliers = async (scope) => {
  const where = buildStoreWhere(scope);
  const [rows] = await query(
    `SELECT ${SUPPLIER_COLUMNS} FROM suppliers ${where.sql} ORDER BY name ASC, id DESC`,
    where.params
  );
  return rows.map(rowToSupplier);
};

const findSupplierById = async (id, scope = {}) => {
  const where = scopedIdWhere(scope, id);
  const [rows] = await query(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers ${where.sql} LIMIT 1`, where.params);
  return rows.length ? rowToSupplier(rows[0]) : null;
};

const createSupplier = async (item, scope) => {
  const name = String(item?.name || "").trim();
  if (!name) return null;
  const [result] = await query(
    `INSERT INTO suppliers (name, phone, email, address, gstin, notes, _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      name,
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
  return findSupplierById(result.insertId, scope);
};

const updateSupplier = async (id, patch, scope = {}) => {
  if (!(await findSupplierById(id, scope))) return null;
  const allowed = ["name", "phone", "email", "address", "gstin", "notes"];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
      sets.push(`\`${key}\` = ?`);
      params.push(key === "name" ? String(patch[key] || "").trim() : patch[key]);
    }
  }
  if (!sets.length) return findSupplierById(id, scope);
  if (sets.some((set, index) => set.startsWith("`name`") && !String(params[index] || "").trim())) {
    throw new Error("name is required");
  }
  const where = scopedIdWhere(scope, id);
  sets.push("updated_at = NOW(3)");
  await query(`UPDATE suppliers SET ${sets.join(", ")} ${where.sql}`, [...params, ...where.params]);
  return findSupplierById(id, scope);
};

const deleteSupplier = async (id, scope = {}) => {
  const where = scopedIdWhere(scope, id);
  const [result] = await query(`DELETE FROM suppliers ${where.sql}`, where.params);
  return result.affectedRows > 0;
};

// === Purchase orders ========================================================

const listPoItems = async (poId) => {
  const [rows] = await query(
    `SELECT ${PO_ITEM_COLUMNS} FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY id ASC`,
    [poId]
  );
  return rows.map(rowToPoItem);
};

const findPurchaseOrderById = async (id, scope = {}) => {
  const where = scopedIdWhere(scope, id);
  const [rows] = await query(`SELECT ${PO_COLUMNS} FROM purchase_orders ${where.sql} LIMIT 1`, where.params);
  if (!rows.length) return null;
  const po = rowToPurchaseOrder(rows[0]);
  po.items = await listPoItems(po.id);
  return po;
};

const listPurchaseOrders = async (scope, filters = {}) => {
  const base = buildStoreWhere(scope);
  const conditions = base.sql ? [base.sql.replace(/^WHERE /, "")] : [];
  const params = [...base.params];
  if (filters.status) {
    conditions.push("status = ?");
    params.push(String(filters.status));
  }
  if (filters.supplierId) {
    conditions.push("supplier_id = ?");
    params.push(Number(filters.supplierId));
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [rows] = await query(
    `SELECT ${PO_COLUMNS} FROM purchase_orders ${where} ORDER BY created_at DESC, id DESC`,
    params
  );
  return Promise.all(rows.map(async (row) => {
    const po = rowToPurchaseOrder(row);
    po.items = await listPoItems(po.id);
    return po;
  }));
};

const assertSupplierInScope = async (supplierId, scope) => {
  if (supplierId == null || supplierId === "") return;
  if (!(await findSupplierById(supplierId, scope))) throw new Error("Supplier not found in this store");
};

const createPurchaseOrder = async (item, scope) => {
  const poNumber = String(item?.poNumber || "").trim();
  if (!poNumber) throw new Error("poNumber is required");
  const items = normalizePoItems(item.items);
  await assertSupplierInScope(item.supplierId, scope);
  await assertCatalogItemsInScope(items, scope);
  const totalAmount = totalForItems(items);
  const id = await withTransaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO purchase_orders (po_number, supplier_id, supplier_name, status, total_amount, notes, expected_at, _store_type, _store_id, _user_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      [
        poNumber,
        item.supplierId || null,
        item.supplierName || null,
        ["draft", "sent"].includes(item.status) ? item.status : "draft",
        totalAmount,
        item.notes || null,
        item.expectedAt || null,
        scope.storeType || null,
        scope.storeId || null,
        scope.email || null,
      ]
    );
    for (const line of items) {
      await conn.execute(
        `INSERT INTO purchase_order_items (purchase_order_id, catalog_type, catalog_id, product_id, product_name, quantity, unit_price, received_quantity)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [result.insertId, line.catalogType, line.catalogId, line.productId, line.productName, line.quantity, line.unitPrice]
      );
    }
    return result.insertId;
  });
  return findPurchaseOrderById(id, scope);
};

const updatePurchaseOrder = async (id, patch, scope = {}) => {
  const current = await findPurchaseOrderById(id, scope);
  if (!current) return null;
  if (current.status === "received" || current.status === "cancelled") {
    throw new Error(`A ${current.status} purchase order cannot be edited`);
  }
  const items = patch.items === undefined ? current.items : normalizePoItems(patch.items);
  await assertSupplierInScope(patch.supplierId ?? current.supplierId, scope);
  if (patch.items !== undefined) await assertCatalogItemsInScope(items, scope);
  const header = {
    poNumber: String(patch.poNumber ?? current.poNumber).trim(),
    supplierId: patch.supplierId ?? current.supplierId,
    supplierName: patch.supplierName ?? current.supplierName,
    status: patch.status ?? current.status,
    notes: patch.notes ?? current.notes,
    expectedAt: patch.expectedAt ?? current.expectedAt,
  };
  if (!header.poNumber) throw new Error("poNumber is required");
  if (!["draft", "sent"].includes(header.status)) throw new Error("Invalid purchase-order status");
  const totalAmount = totalForItems(items);
  await withTransaction(async (conn) => {
    const where = scopedIdWhere(scope, id);
    const [result] = await conn.execute(
      `UPDATE purchase_orders SET po_number=?, supplier_id=?, supplier_name=?, status=?, total_amount=?, notes=?, expected_at=?, updated_at=NOW(3) ${where.sql.replace(/^WHERE/, "WHERE")}`,
      [header.poNumber, header.supplierId || null, header.supplierName || null, header.status, totalAmount, header.notes || null, header.expectedAt || null, ...where.params]
    );
    if (!result.affectedRows) throw new Error("Purchase order not found");
    if (patch.items !== undefined) {
      await conn.execute("DELETE FROM purchase_order_items WHERE purchase_order_id = ?", [id]);
      for (const line of items) {
        await conn.execute(
          `INSERT INTO purchase_order_items (purchase_order_id, catalog_type, catalog_id, product_id, product_name, quantity, unit_price, received_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
          [id, line.catalogType, line.catalogId, line.productId, line.productName, line.quantity, line.unitPrice]
        );
      }
    }
  });
  return findPurchaseOrderById(id, scope);
};

const deletePurchaseOrder = async (id, scope = {}) => {
  const po = await findPurchaseOrderById(id, scope);
  if (!po) return false;
  if (po.status === "received") throw new Error("Received purchase orders cannot be deleted");
  const where = scopedIdWhere(scope, id);
  const [result] = await query(`DELETE FROM purchase_orders ${where.sql}`, where.params);
  return result.affectedRows > 0;
};

const receivePurchaseOrder = async (id, scope = {}) => {
  const po = await findPurchaseOrderById(id, scope);
  if (!po) return null;
  if (po.status === "received") return { ...po, movements: [] };
  if (po.status === "cancelled") throw new Error("Cancelled purchase orders cannot be received");
  const movements = [];
  await withTransaction(async (conn) => {
    const where = scopedIdWhere(scope, id);
    const [updated] = await conn.execute(
      `UPDATE purchase_orders SET status='received', received_at=NOW(3), updated_at=NOW(3) ${where.sql}`,
      where.params
    );
    if (!updated.affectedRows) throw new Error("Purchase order not found");
    const [items] = await conn.execute(
      `SELECT id, catalog_type, catalog_id, product_id, product_name, quantity, unit_price, received_quantity FROM purchase_order_items WHERE purchase_order_id=? ORDER BY id ASC`,
      [id]
    );
    for (const item of items) {
      const remaining = Number(item.quantity || 0) - Number(item.received_quantity || 0);
      if (remaining <= 0) continue;
      await conn.execute("UPDATE purchase_order_items SET received_quantity=? WHERE id=?", [item.quantity, item.id]);
      const [move] = await conn.execute(
        `INSERT INTO stock_movements (product_id, product_name, type, quantity, reason, purchase_order_id, _store_type, _store_id, created_at)
         VALUES (?, ?, 'in', ?, ?, ?, ?, ?, NOW(3))`,
        [item.product_id, item.product_name, remaining, `PO ${po.poNumber}`, id, scope.storeType || null, scope.storeId || null]
      );
      movements.push({
        id: move.insertId,
        quantity: remaining,
        productId: item.product_id,
        catalogType: item.catalog_type === "service" ? "service" : "product",
        catalogId: item.catalog_id,
      });
      if (item.catalog_type !== "service" && item.product_id) {
        await conn.execute(
          `UPDATE products SET stock=stock+?, updated_at=NOW(3) WHERE id=?${scope.storeType ? " AND _store_type=?" : ""}${scope.storeId ? " AND _store_id=?" : ""}`,
          [remaining, item.product_id, ...(scope.storeType ? [scope.storeType] : []), ...(scope.storeId ? [scope.storeId] : [])]
        );
      }
    }
  });
  return { ...(await findPurchaseOrderById(id, scope)), movements };
};

// === Stock movements ========================================================

const listStockMovements = async (scope, filters = {}) => {
  const base = buildStoreWhere(scope);
  const conditions = base.sql ? [base.sql.replace(/^WHERE /, "")] : [];
  const params = [...base.params];
  if (filters.productId) {
    conditions.push("product_id = ?");
    params.push(Number(filters.productId));
  }
  if (filters.type) {
    conditions.push("type = ?");
    params.push(String(filters.type));
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [rows] = await query(
    `SELECT ${STOCK_MOVE_COLUMNS} FROM stock_movements ${where} ORDER BY created_at DESC, id DESC LIMIT 500`,
    params
  );
  return rows.map(rowToStockMovement);
};

const createStockMovement = async (item, scope) => {
  const productId = Number(item?.productId);
  const type = String(item?.type || "");
  const quantity = Number(item?.quantity);
  if (!Number.isInteger(productId) || productId <= 0) throw new Error("productId is required");
  if (!["in", "out", "adjustment"].includes(type)) throw new Error("Invalid movement type");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("quantity must be greater than zero");
  const productWhere = scopedIdWhere(scope, productId);
  const [productRows] = await query(`SELECT id, name FROM products ${productWhere.sql} LIMIT 1`, productWhere.params);
  if (!productRows.length) throw new Error("Product not found in this store");
  const product = productRows[0];
  const direction = type === "out" || (type === "adjustment" && item.adjustmentDirection === "decrease") ? -1 : 1;
  const [result] = await query(
    `INSERT INTO stock_movements (product_id, product_name, type, quantity, reason, created_by, _store_type, _store_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [productId, item.productName || product.name || "", type, quantity, item.reason || null, item.createdBy || null, scope.storeType || null, scope.storeId || null]
  );
  await query(
    `UPDATE products SET stock=GREATEST(0, stock + ?), updated_at=NOW(3) WHERE id=?${scope.storeType ? " AND _store_type=?" : ""}${scope.storeId ? " AND _store_id=?" : ""}`,
    [direction * quantity, productId, ...(scope.storeType ? [scope.storeType] : []), ...(scope.storeId ? [scope.storeId] : [])]
  );
  return findStockMovementById(result.insertId, scope);
};

const findStockMovementById = async (id, scope = {}) => {
  const where = scopedIdWhere(scope, id);
  const [rows] = await query(`SELECT ${STOCK_MOVE_COLUMNS} FROM stock_movements ${where.sql} LIMIT 1`, where.params);
  return rows.length ? rowToStockMovement(rows[0]) : null;
};

// === Low-stock alerts ======================================================

const lowStockAlerts = async (scope) => {
  const where = buildStoreWhere(scope);
  const [rows] = await query(
    `SELECT id, name, stock, low_stock, _store_type, _store_id, category FROM products
     ${where.sql ? `${where.sql} AND` : "WHERE"} low_stock > 0 AND stock <= low_stock
     ORDER BY (stock-low_stock) ASC, name ASC LIMIT 200`,
    where.params
  );
  return rows.map((row) => {
    const stock = toNumber(row.stock) ?? 0;
    const lowStock = toNumber(row.low_stock) ?? 0;
    const deficit = Math.max(0, lowStock - stock);
    return {
      id: Number(row.id),
      name: row.name || "",
      stock,
      lowStock,
      lowStockLimit: lowStock,
      deficit,
      severity: stock <= 0 ? "out" : stock <= lowStock * 0.5 ? "critical" : "low",
      category: row.category || null,
      _storeType: row._store_type || null,
      _storeId: row._store_id || null,
    };
  });
};

module.exports = {
  listSuppliers,
  findSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  listPurchaseOrders,
  findPurchaseOrderById,
  listPoItems,
  createPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
  receivePurchaseOrder,
  listStockMovements,
  createStockMovement,
  findStockMovementById,
  lowStockAlerts,
  normalizePoItems,
};
