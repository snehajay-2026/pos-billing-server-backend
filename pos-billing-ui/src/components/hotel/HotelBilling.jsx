import React, { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getProducts, updateProduct as updateProductStockApi } from "../../services/productService";
import { saveInvoice } from "../../services/invoiceService";
import { getUser } from "../../utils/auth";
import hotelService from '../../services/hotelService';
import { useUi } from '../../context/UiContext';
import { FaBed, FaUtensils, FaChair, FaUserTie, FaPlus, FaTrash, FaSave, FaReceipt, FaRupeeSign, FaDoorOpen, FaTable, FaCheckCircle, FaMapMarkerAlt, FaEdit } from "react-icons/fa";
import "./HotelBilling.css";
import ReactDOM from 'react-dom/client';
import LodgingInvoice from './LodgingInvoice';
import DiningInvoice from './DiningInvoice';

const diningCategories = ["Veg Menu", "Non Veg Menu", "Starter", "Chinese"];
const TABLES_STORAGE_KEY = "hotel_table_booking_state";
const WAITING_QUEUE_KEY = "hotel_table_booking_waiting_list";
const CHECKOUT_HISTORY_STORAGE_KEY = "hotel_lodging_checkout_history";
const defaultHotelTables = [
  { id: "T1", name: "Table 1", seats: 2, status: "empty" },
  { id: "T2", name: "Table 2", seats: 2, status: "empty" },
  { id: "T3", name: "Table 3", seats: 4, status: "empty" },
  { id: "T4", name: "Table 4", seats: 4, status: "empty" },
  { id: "T5", name: "Table 5", seats: 6, status: "empty" },
  { id: "T6", name: "Table 6", seats: 8, status: "empty" },
];

const normalizeDiningTables = (inputTables = []) => {
  const byKey = new Map();
  inputTables.forEach((table, index) => {
    if (!table || typeof table !== 'object') return;
    const normalizedTable = {
      ...table,
      id: String(table.id != null ? table.id : table.name || ''),
      _persisted: table._persisted !== false,
    };
    const tableIdentity = table.id != null
      ? `id:${String(table.id)}`
      : `name:${String(table.name || '').trim().toLowerCase()}`;
    const rank = new Date(table.updatedAt || table.createdAt || 0).getTime() || index;
    const previous = byKey.get(tableIdentity);
    if (!previous || rank >= previous.rank) {
      byKey.set(tableIdentity, { value: normalizedTable, rank });
    }
  });
  return Array.from(byKey.values()).map((entry) => entry.value);
};

const flattenDiningBills = (bills = []) => bills.flatMap((bill) => {
  const items = Array.isArray(bill.items) ? bill.items : [];
  const normalizedTableId = String(bill.tableId || '');
  return items.map((item, index) => ({
    ...item,
    id: item.id || `${normalizedTableId}-${item.name || 'item'}-${index}`,
    type: 'dining',
    qty: Number(item.qty || 1),
    rate: Number(item.rate || 0),
    total: Number(item.total || 0),
    gst: Number(item.gst || 0),
    meta: {
      ...(item.meta || {}),
      tableId: normalizedTableId,
      tableName: bill.tableName,
      guest: bill.guestName || item.meta?.guest || '',
      partySize: bill.partySize || item.meta?.partySize || 0,
      checkInDate: bill.checkInDate || item.meta?.checkInDate || '',
      checkInTime: bill.checkInTime || item.meta?.checkInTime || '',
      checkOutTime: bill.checkOutTime || item.meta?.checkOutTime || '',
    },
  }));
});

const buildDiningBillsMap = (bills = []) => bills.reduce((acc, bill) => {
  if (bill?.tableId == null) return acc;
  acc[String(bill.tableId)] = bill;
  return acc;
}, {});

const summarizeDiningBillItems = (items = []) => {
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .map((item) => `${Number(item.qty || 1)}x ${item.name || 'Item'}`)
    .join(', ');
};

const normalizeOrderedMenuItems = (table) => {
  if (Array.isArray(table?.orderedMenuItems) && table.orderedMenuItems.length) {
    return table.orderedMenuItems
      .map((item) => {
        if (!item) return null;
        if (typeof item === 'string') {
          return { name: item, qty: 1 };
        }
        return {
          productId: item.productId || item.id || undefined,
          name: item.name || 'Menu Item',
          category: item.category || '',
          qty: Math.max(1, Number(item.qty || 1)),
        };
      })
      .filter(Boolean);
  }

  const summary = String(table?.orderSummary || '').trim();
  if (!summary) return [];

  return summary
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const match = segment.match(/^(\d+)x\s+(.+)$/i);
      if (match) {
        return { name: match[2].trim(), qty: Math.max(1, Number(match[1] || 1)) };
      }
      return { name: segment, qty: 1 };
    });
};

const summarizeOrderedMenuItems = (items = []) => {
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .map((item) => `${Math.max(1, Number(item.qty || 1))}x ${item.name || 'Menu Item'}`)
    .join(', ');
};

const formatTime12Hour = (timeValue) => {
  const rawTime = String(timeValue || '').trim();
  if (!rawTime) return '';
  if (/am|pm/i.test(rawTime)) return rawTime.toUpperCase();

  const match = rawTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return rawTime;

  const hours = Number(match[1]);
  const minutes = match[2];
  if (Number.isNaN(hours)) return rawTime;

  const normalizedHour = ((hours % 24) + 24) % 24;
  const suffix = normalizedHour >= 12 ? 'PM' : 'AM';
  const hour12 = normalizedHour % 12 || 12;
  return `${String(hour12).padStart(2, '0')}:${minutes} ${suffix}`;
};

const getDiningProductVariants = (product) => {
  if (!product) return [];
  const variants = [];
  if (product.halfPrice !== null && product.halfPrice !== undefined && product.halfPrice !== '') {
    variants.push({ value: 'half', label: 'Half', price: Number(product.halfPrice || 0) });
  }
  if (product.fullPrice !== null && product.fullPrice !== undefined && product.fullPrice !== '') {
    variants.push({ value: 'full', label: 'Full', price: Number(product.fullPrice || 0) });
  }
  if (!variants.length) {
    variants.push({ value: 'regular', label: 'Regular', price: Number(product.price || 0) });
  }
  return variants;
};

const getDiningStockState = (product) => {
  const stock = Number(product?.stock || 0);
  const limit = Number(product?.lowStockLimit || product?.limit || 0);
  if (stock <= 0) return 'out';
  if (limit > 0 && stock <= limit) return 'low';
  return 'ok';
};

const buildLodgingBillItem = ({ room, guest, customerMobile, nights, rate, notes, idProof, checkInDate, checkInTime, source }) => ({
  id: `lodging-booking-${room.id}`,
  name: `Room Booking - ${room.name}`,
  type: 'lodging',
  qty: 1,
  rate: Number(rate || 0) * Number(nights || 1),
  gst: 0,
  total: Number(rate || 0) * Number(nights || 1),
  meta: {
    roomId: room.id,
    roomName: room.name,
    guest: String(guest || '').trim(),
    customerMobile: String(customerMobile || '').trim(),
    notes: notes || '',
    idProof: idProof || undefined,
    nights: Number(nights || 1),
    roomRate: Number(rate || 0),
    roomAc: String(room.ac || '').trim(),
    roomModern: Boolean(room.modern),
    checkInDate,
    checkInTime,
  },
  source,
});

const replaceLodgingBillItem = (prevItems, nextItem) => {
  const roomId = nextItem?.meta?.roomId;
  const filtered = prevItems.filter((item) => {
    if (!item || item.type !== 'lodging') return true;
    if (item.id === nextItem.id) return false;
    if (roomId && item.meta?.roomId === roomId) return false;
    return true;
  });
  return [nextItem, ...filtered];
};

const HotelBilling = () => {
  const [products, setProducts] = useState([]);
  const [tables, setTables] = useState([]);

  const [notes, setNotes] = useState("");
  const [paymentMode, setPaymentMode] = useState('Cash');
  const [activeTab, setActiveTab] = useState("lodging");

  const [selectedProduct, setSelectedProduct] = useState("");
  const [selectedProductVariant, setSelectedProductVariant] = useState("regular");
  const [quantity, setQuantity] = useState(1);
  const [lodgingDescription, setLodgingDescription] = useState("");
  const [lodgingAmount, setLodgingAmount] = useState("");
  const [items, setItems] = useState([]);
  const [message, setMessage] = useState(null);
  const [lodgingRooms, setLodgingRooms] = useState([]);
  const navigate = useNavigate();
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingRoom, setEditingRoom] = useState(null);
  const [showSyncToast, setShowSyncToast] = useState(false);
  const [showQuickBookModal, setShowQuickBookModal] = useState(false);
  const [quickBookRoom, setQuickBookRoom] = useState(null);
  const [qbOpenDetails, setQbOpenDetails] = useState(null);
  const [selectedDiningTable, setSelectedDiningTable] = useState(null);
  const [diningGuestName, setDiningGuestName] = useState('');
  const [diningCustomerMobile, setDiningCustomerMobile] = useState('');
  const [diningPartySize, setDiningPartySize] = useState(1);
  const [diningOrderedMenu, setDiningOrderedMenu] = useState('');
  const [selectedDiningMenus, setSelectedDiningMenus] = useState([]);
  const [selectedDiningMenuProductId, setSelectedDiningMenuProductId] = useState('');
  const [diningGuestError, setDiningGuestError] = useState('');
  const [diningMobileError, setDiningMobileError] = useState('');
  const [isEditingDiningTable, setIsEditingDiningTable] = useState(false);
  const [editDiningTableName, setEditDiningTableName] = useState('');
  const [editDiningTableSeats, setEditDiningTableSeats] = useState(2);
  const [editDiningTableZone, setEditDiningTableZone] = useState('Main');
  const [waitingQueue, setWaitingQueue] = useState([]);
  const [activeDiningTableId, setActiveDiningTableId] = useState(null);
  const [diningBillsByTable, setDiningBillsByTable] = useState({});
  const { showToast } = useUi();
  const [qbGuestName, setQbGuestName] = useState('');
  const [qbCustomerMobile, setQbCustomerMobile] = useState('');
  const [qbNights, setQbNights] = useState(1);
  const [qbMembers, setQbMembers] = useState(1);
  const [qbNotes, setQbNotes] = useState('');
  const [qbIdType, setQbIdType] = useState('');
  const [qbIdNumber, setQbIdNumber] = useState('');
  const [qbRate, setQbRate] = useState('');
  const [qbGst, setQbGst] = useState('');
  const [qbCheckInDate, setQbCheckInDate] = useState('');
  const [qbCheckInTime, setQbCheckInTime] = useState('');
  const [qbErrors, setQbErrors] = useState({ guest: false, mobile: false, nights: false, members: false, rate: false, gst: false, idType: false, idNumber: false });
  const [editingRoomErrors, setEditingRoomErrors] = useState({ guest: false, mobile: false, nights: false, members: false, rate: false, gst: false, checkIn: false, idType: false, idNumber: false });
  // feature flag: set to false to hide quick-edit UI. Can also hide by adding `no-quick-edit` class on <body>.
  const QUICK_EDIT_FEATURE = true;
  const quickEditEnabled = QUICK_EDIT_FEATURE && !(typeof document !== 'undefined' && document.body.classList.contains('no-quick-edit'));

  const user = getUser();
  const billedByDisplayName = user?.name?.trim() || user?.email || 'unknown';
  const zoneOptions = ["Main", "Window", "Garden", "Terrace"];

  // persist last active POS tab across reloads
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("hotel_active_pos");
      if (saved === "lodging" || saved === "dining") setActiveTab(saved);
    } catch (err) {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("hotel_active_pos", activeTab);
    } catch (err) {}
  }, [activeTab]);

  useEffect(() => {
    const load = async () => {
      try {
        const list = await getProducts();
        setProducts(Array.isArray(list) ? list : []);
      } catch (error) {
        console.error("Failed to load hotel products", error);
      }
    };
    load();

    const loadTables = async () => {
      try {
        const resp = await hotelService.getTables();
        if (Array.isArray(resp) && resp.length > 0) {
          setTables(normalizeDiningTables(resp));
          return;
        }
      } catch (error) {
        // fallback to local storage
      }
      const savedTables = window.localStorage.getItem(TABLES_STORAGE_KEY);
      if (savedTables) {
        try {
          const parsed = JSON.parse(savedTables);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setTables(normalizeDiningTables(parsed));
            return;
          }
        } catch (error) {
          // ignore and fallback
        }
      }
      setTables(defaultHotelTables);
    };
    loadTables();
    const loadDiningBills = async () => {
      try {
        const bills = await hotelService.getDiningBills();
        if (Array.isArray(bills)) {
          setDiningBillsByTable(buildDiningBillsMap(bills));
          setItems((prev) => [...prev.filter((item) => item.type !== 'dining'), ...flattenDiningBills(bills)]);
        }
      } catch (err) {
        console.warn('Failed to load dining bills', err);
      }
    };
    loadDiningBills();
    try {
      const savedWaiting = window.localStorage.getItem(WAITING_QUEUE_KEY);
      if (savedWaiting) {
        const parsedWaiting = JSON.parse(savedWaiting);
        if (Array.isArray(parsedWaiting)) setWaitingQueue(parsedWaiting);
      }
    } catch (err) {
      // ignore
    }
    // Remove any previously stored shared lodging items so Billing does not auto-populate default bills
    try {
      window.localStorage.removeItem('hotel_shared_items');
    } catch (err) {
      console.warn('Failed to clear default shared lodging items', err);
    }
    // load lodging rooms so billing shows the same cards
    try {
      const savedRooms = window.localStorage.getItem('hotel_lodging_rooms');
      if (savedRooms) {
        const parsed = JSON.parse(savedRooms);
        if (Array.isArray(parsed)) setLodgingRooms(parsed);
      }
    } catch (err) {
      console.warn('Failed to load lodging rooms', err);
    }
  }, []);

  useEffect(() => {
    const onStorage = (e) => {
      if (!e || !e.key) return;
      try {
        if (e.key === TABLES_STORAGE_KEY) {
          const parsed = JSON.parse(e.newValue || '[]');
          if (Array.isArray(parsed)) setTables(normalizeDiningTables(parsed));
        }
        if (e.key === 'hotel_lodging_rooms') {
          const parsed = JSON.parse(e.newValue || '[]');
          if (Array.isArray(parsed)) setLodgingRooms(parsed);
        }
        if (e.key === 'hotel_shared_items') {
          const shared = JSON.parse(e.newValue || '[]');
          if (Array.isArray(shared)) {
            setItems((prev) => {
              try {
                // Build map of roomId -> shared item (prefer latest in array)
                const roomMap = new Map();
                shared.forEach(s => { if (s && s.meta && s.meta.roomId) roomMap.set(s.meta.roomId, s); });
                // Keep non-lodging items and lodging items for rooms not present in shared.
                // If a room is present in shared, drop the stale local copy and re-add the merged one below.
                const others = prev.filter(p => {
                  try {
                    if (p && p.type === 'lodging' && p.meta && p.meta.roomId) {
                      return !roomMap.has(p.meta.roomId);
                    }
                  } catch (e) {}
                  return true;
                });
                const mergedShared = Array.from(roomMap.values()).map(s => {
                  const prevItem = prev.find(p => p.id === s.id);
                  return prevItem ? { ...prevItem, ...s } : s;
                });
                return [...mergedShared, ...others];
              } catch (err) {
                return prev;
              }
            });
          }
        }
      } catch (err) {
        // ignore
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // same-tab listeners (CustomEvent) for instant sync without relying on storage events
  useEffect(() => {
    const onSharedEvent = (e) => {
      try {
        const shared = e.detail || JSON.parse(window.localStorage.getItem('hotel_shared_items') || '[]');
        if (Array.isArray(shared) && shared.length > 0) {
          setItems((prev) => {
            try {
              const roomMap = new Map();
              shared.forEach(s => { if (s && s.meta && s.meta.roomId) roomMap.set(s.meta.roomId, s); });
              const mergedShared = Array.from(roomMap.values()).map(s => {
                const prevItem = prev.find(p => p.id === s.id);
                return prevItem ? { ...prevItem, ...s } : s;
              });
              const others = prev.filter(p => {
                try {
                  if (p && p.type === 'lodging' && p.meta && p.meta.roomId) {
                    return !roomMap.has(p.meta.roomId);
                  }
                } catch (e) {}
                return true;
              });
              if (mergedShared.length) setActiveTab('lodging');
              return [...mergedShared, ...others];
            } catch (err) {
              return prev;
            }
          });
        }
      } catch (err) {
        // ignore
      }
    };

    const onRoomsEvent = (e) => {
      try {
        const rooms = e.detail || JSON.parse(window.localStorage.getItem('hotel_lodging_rooms') || '[]');
        if (Array.isArray(rooms)) setLodgingRooms(rooms);
      } catch (err) {
        // ignore
      }
    };

    const onTablesEvent = (e) => {
      try {
        const nextTables = e.detail || JSON.parse(window.localStorage.getItem(TABLES_STORAGE_KEY) || '[]');
        if (Array.isArray(nextTables)) setTables(normalizeDiningTables(nextTables));
      } catch (err) {
        // ignore
      }
    };

    const onWaitingListEvent = (e) => {
      try {
        const list = e.detail || JSON.parse(window.localStorage.getItem(WAITING_QUEUE_KEY) || '[]');
        if (Array.isArray(list)) setWaitingQueue(list);
      } catch (err) {
        // ignore
      }
    };

    window.addEventListener('hotel_shared_items_updated', onSharedEvent);
    window.addEventListener('hotel_lodging_rooms_updated', onRoomsEvent);
    window.addEventListener('hotel_table_booking_updated', onTablesEvent);
    window.addEventListener('hotel_waiting_list_updated', onWaitingListEvent);
    const onQuickBookEvent = (e) => {
      try {
        const id = e?.detail?.roomId || e?.detail?.id;
        if (id) openQuickBook(id, e?.detail || {});
      } catch (err) {}
    };
    window.addEventListener('hotel_quick_book', onQuickBookEvent);
    return () => {
      window.removeEventListener('hotel_shared_items_updated', onSharedEvent);
      window.removeEventListener('hotel_lodging_rooms_updated', onRoomsEvent);
      window.removeEventListener('hotel_table_booking_updated', onTablesEvent);
      window.removeEventListener('hotel_waiting_list_updated', onWaitingListEvent);
      window.removeEventListener('hotel_quick_book', onQuickBookEvent);
    };
  }, []);

  const syncDiningTables = (nextTables) => {
    const normalizedTables = normalizeDiningTables(nextTables);
    setTables(normalizedTables);
    try {
      window.localStorage.setItem(TABLES_STORAGE_KEY, JSON.stringify(normalizedTables));
      window.dispatchEvent(new CustomEvent('hotel_table_booking_updated', { detail: normalizedTables }));
    } catch (err) {
      // ignore
    }
  };

  const applyDiningBillLocally = (table, nextDiningItems) => {
    const normalizedTableId = String(table.id || '');
    const normalizedItems = nextDiningItems.map((item, index) => ({
      ...item,
      id: item.id || `${normalizedTableId}-${item.name || 'item'}-${index}`,
      type: 'dining',
      qty: Number(item.qty || 1),
      rate: Number(item.rate || 0),
      total: Number(item.total || 0),
      gst: Number(item.gst || 0),
      meta: {
        ...(item.meta || {}),
        tableId: normalizedTableId,
        tableName: table.name,
        guest: table.guest || '',
        partySize: table.partySize || 0,
        checkInDate: table.checkInDate || '',
        checkInTime: table.checkInTime || '',
      },
    }));

    setItems((prev) => [
      ...prev.filter((item) => !(item.type === 'dining' && String(item.meta?.tableId) === normalizedTableId)),
      ...normalizedItems,
    ]);
    setDiningBillsByTable((prev) => {
      const next = { ...prev };
      if (!normalizedItems.length) {
        delete next[normalizedTableId];
        return next;
      }
      next[normalizedTableId] = {
        ...(prev[normalizedTableId] || {}),
        tableId: normalizedTableId,
        tableName: table.name,
        guestName: table.guest || '',
        partySize: table.partySize || 0,
        checkInDate: table.checkInDate || '',
        checkInTime: table.checkInTime || '',
        checkOutTime: table.checkOutTime || '',
        items: normalizedItems,
        openItemCount: normalizedItems.reduce((sum, item) => sum + Number(item.qty || 0), 0),
        totalAmount: normalizedItems.reduce((sum, item) => sum + Number(item.total || 0), 0),
        status: normalizedItems.length ? 'open' : 'closed',
        updatedAt: new Date().toISOString(),
      };
      return next;
    });
  };

  const persistDiningBill = async (table, nextDiningItems) => {
    if (!table?.id) return false;
    applyDiningBillLocally(table, nextDiningItems);
    try {
      const normalizedTableId = String(table.id || '');
      if (!nextDiningItems.length) {
        await hotelService.clearDiningBill(normalizedTableId);
        return true;
      }
      const saved = await hotelService.saveDiningBill(normalizedTableId, {
        tableId: normalizedTableId,
        tableName: table.name,
        guestName: table.guest || '',
        partySize: table.partySize || 0,
        checkInDate: table.checkInDate || '',
        checkInTime: table.checkInTime || '',
        checkOutTime: table.checkOutTime || '',
        items: nextDiningItems.map((item) => ({
          ...item,
          type: 'dining',
          meta: {
            ...(item.meta || {}),
            tableId: normalizedTableId,
            tableName: table.name,
            guest: table.guest || '',
            partySize: table.partySize || 0,
            checkInDate: table.checkInDate || '',
            checkInTime: table.checkInTime || '',
            checkOutTime: table.checkOutTime || item.meta?.checkOutTime || '',
          },
        })),
      });
      if (saved) {
        setDiningBillsByTable((prev) => ({ ...prev, [normalizedTableId]: saved }));
        setItems((prev) => [...prev.filter((item) => !(item.type === 'dining' && String(item.meta?.tableId) === normalizedTableId)), ...flattenDiningBills([saved])]);
      }
      return true;
    } catch (err) {
      console.warn('Failed to sync dining bill', err);
      showToast('error', 'Bill Items updated locally. Server sync failed.');
      return true;
    }
  };

  const openDiningTableBooking = (table) => {
    if (!table) return;
    const orderedMenuItems = normalizeOrderedMenuItems(table);
    setIsEditingDiningTable(false);
    setSelectedDiningTable(table);
    setDiningGuestName(table.guest || '');
    setDiningCustomerMobile(table.customerMobile || '');
    setDiningPartySize(table.partySize || 1);
    setSelectedDiningMenus(orderedMenuItems);
    setSelectedDiningMenuProductId('');
    setDiningOrderedMenu(summarizeOrderedMenuItems(orderedMenuItems) || table.orderSummary || '');
    setDiningGuestError('');
    setDiningMobileError('');
    setEditDiningTableName(table.name || '');
    setEditDiningTableSeats(Number(table.seats || 2));
    setEditDiningTableZone(table.zone || 'Main');
    setMessage(null);
  };

  const openDiningTableEdit = (table) => {
    if (!table) return;
    const orderedMenuItems = normalizeOrderedMenuItems(table);
    setIsEditingDiningTable(true);
    setSelectedDiningTable(table);
    setDiningGuestName(table.guest || '');
    setDiningCustomerMobile(table.customerMobile || '');
    setDiningPartySize(table.partySize || 1);
    setSelectedDiningMenus(orderedMenuItems);
    setSelectedDiningMenuProductId('');
    setDiningOrderedMenu(summarizeOrderedMenuItems(orderedMenuItems) || table.orderSummary || '');
    setDiningGuestError('');
    setDiningMobileError('');
    setEditDiningTableName(table.name || '');
    setEditDiningTableSeats(Number(table.seats || 2));
    setEditDiningTableZone(table.zone || 'Main');
    setMessage(null);
  };

  const closeDiningTableBooking = () => {
    setSelectedDiningTable(null);
    setIsEditingDiningTable(false);
    setDiningGuestName('');
    setDiningCustomerMobile('');
    setDiningPartySize(1);
    setDiningOrderedMenu('');
    setSelectedDiningMenus([]);
    setSelectedDiningMenuProductId('');
    setDiningGuestError('');
    setDiningMobileError('');
    setEditDiningTableName('');
    setEditDiningTableSeats(2);
    setEditDiningTableZone('Main');
  };

  const handleDiningTableBook = async () => {
    if (!selectedDiningTable) return;
    const missingGuestName = !diningGuestName.trim();
    const invalidMobileNumber = !/^\d{10}$/.test(diningCustomerMobile.trim());
    if (missingGuestName) {
      setDiningGuestError('Enter guest name to book the table.');
    }
    if (invalidMobileNumber) {
      setDiningMobileError(diningCustomerMobile.trim()
        ? 'Mobile number must be exactly 10 digits.'
        : 'Enter mobile number to book the table.');
    }
    if (missingGuestName || invalidMobileNumber) {
      showToast('error', missingGuestName && invalidMobileNumber
        ? 'Enter guest name and a valid 10-digit mobile number to confirm booking.'
        : missingGuestName
          ? 'Enter guest name to confirm booking.'
          : diningCustomerMobile.trim()
            ? 'Mobile number must be exactly 10 digits.'
            : 'Enter mobile number to confirm booking.');
      return;
    }
    setDiningGuestError('');
    setDiningMobileError('');
    const maxSeats = Number(selectedDiningTable.seats || 1);
    if (!diningPartySize || diningPartySize < 1 || diningPartySize > maxSeats) {
      setMessage({ type: 'error', text: `Party size must be between 1 and ${maxSeats}.` });
      return;
    }

    const orderSummary = summarizeOrderedMenuItems(selectedDiningMenus);
    const selectedDiningTableId = String(selectedDiningTable.id || '');
    const bookingTimestamp = new Date();
    const resolvedCheckInDate = isEditingDiningTable && selectedDiningTable.checkInDate
      ? selectedDiningTable.checkInDate
      : bookingTimestamp.toISOString().slice(0, 10);
    const resolvedCheckInTime = isEditingDiningTable && selectedDiningTable.checkInTime
      ? selectedDiningTable.checkInTime
      : formatTime12Hour(`${String(bookingTimestamp.getHours()).padStart(2, '0')}:${String(bookingTimestamp.getMinutes()).padStart(2, '0')}`);
    const nextTables = tables.map((table) => String(table.id) === selectedDiningTableId ? {
      ...table,
      name: isEditingDiningTable ? editDiningTableName.trim() : table.name,
      seats: isEditingDiningTable ? Number(editDiningTableSeats || table.seats || 2) : table.seats,
      zone: isEditingDiningTable ? editDiningTableZone : table.zone,
      status: 'booked',
      guest: diningGuestName.trim(),
      customerMobile: diningCustomerMobile.trim(),
      partySize: Number(diningPartySize),
      orderSummary,
      orderedMenuItems: selectedDiningMenus,
      checkInDate: resolvedCheckInDate,
      checkInTime: resolvedCheckInTime,
    } : table);
    syncDiningTables(nextTables);
    setActiveDiningTableId(selectedDiningTableId);
    const updatedTable = nextTables.find((table) => String(table.id) === selectedDiningTableId);
    const existingBill = diningBillsByTable[selectedDiningTableId];
    if (updatedTable && existingBill?.items?.length) {
      persistDiningBill(updatedTable, existingBill.items);
    }
    setMessage({ type: 'success', text: `${(isEditingDiningTable ? editDiningTableName : selectedDiningTable.name) || selectedDiningTable.name} booked for ${diningGuestName.trim()}.` });
    closeDiningTableBooking();
    try {
      await hotelService.updateTable(selectedDiningTable.id, nextTables.find((table) => table.id === selectedDiningTable.id) || {});
    } catch (err) {
      showToast('error', 'Failed to sync table booking to server.');
    }
  };

  const handleDiningTableClear = async (tableId) => {
    const normalizedTableId = String(tableId);
    const sourceTable = tables.find((table) => String(table.id) === normalizedTableId);
    if (!sourceTable) return;
    const existingBill = diningBillsByTable[normalizedTableId];
    const existingBillItems = Array.isArray(existingBill?.items) ? existingBill.items : [];
    const orderedMenuItems = normalizeOrderedMenuItems(sourceTable);
    const clearTimestamp = new Date();
    const checkOutTime = formatTime12Hour(`${String(clearTimestamp.getHours()).padStart(2, '0')}:${String(clearTimestamp.getMinutes()).padStart(2, '0')}`);
    const orderedMenuBillEntries = [];

    for (const orderedItem of orderedMenuItems) {
      const matchingProduct = products.find((product) => {
        if (orderedItem.productId) {
          return String(product.id) === String(orderedItem.productId);
        }
        return String(product.name || '').trim().toLowerCase() === String(orderedItem.name || '').trim().toLowerCase();
      });

      if (!matchingProduct) {
        setMessage({ type: 'error', text: `${orderedItem.name || 'Booked menu item'} is missing from Hotel Menu, so the table cannot be cleared into billing yet.` });
        return;
      }

      const existingQty = existingBillItems
        .filter((item) => {
          const sameProductId = orderedItem.productId && item.meta?.productId && String(item.meta.productId) === String(orderedItem.productId);
          const sameName = String(item.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase() === String(orderedItem.name || '').trim().toLowerCase();
          return sameProductId || sameName;
        })
        .reduce((sum, item) => sum + Number(item.qty || 0), 0);

      const qtyToAdd = Math.max(0, Number(orderedItem.qty || 0) - existingQty);
      if (qtyToAdd <= 0) continue;

      orderedMenuBillEntries.push({
        orderedItem,
        product: matchingProduct,
        qtyToAdd,
      });
    }

    const deductedStock = [];
    for (const entry of orderedMenuBillEntries) {
      if (Number(entry.product.stock || 0) < entry.qtyToAdd) {
        setMessage({ type: 'error', text: `Only ${Number(entry.product.stock || 0)} unit(s) available for ${entry.product.name}. Clear the table after updating the bill or stock.` });
        return;
      }

      const stockResult = await syncProductStock(entry.product, -entry.qtyToAdd);
      if (!stockResult.ok) {
        for (const rollbackEntry of deductedStock.reverse()) {
          await syncProductStock(rollbackEntry.product, rollbackEntry.qty);
        }
        setMessage({ type: 'error', text: `Failed to move ${entry.product.name} into Bill Items.` });
        return;
      }

      deductedStock.push({
        product: stockResult.product || entry.product,
        qty: entry.qtyToAdd,
      });
    }

    const generatedBillItems = orderedMenuBillEntries.map((entry, index) => {
      const itemRate = Number(entry.product.fullPrice || entry.product.price || 0);
      const itemName = String(entry.orderedItem.name || entry.product.name || '').trim() || String(entry.product.name || '').trim();
      const itemCategory = String(entry.orderedItem.category || entry.product.category || 'Dining').trim();
      const itemProductId = entry.orderedItem.productId || entry.product.id;
      const normalizedTableId = String(sourceTable.id || '');
      return {
        id: `${normalizedTableId}-${itemProductId || itemName}-clear-${Date.now()}-${index}`,
        name: itemName,
        type: 'dining',
        qty: entry.qtyToAdd,
        rate: itemRate,
        gst: Number(entry.product.gst || 0),
        total: entry.qtyToAdd * itemRate,
        category: itemCategory || 'Dining',
        meta: {
          tableId: normalizedTableId,
          checkOutTime,
          productId: itemProductId,
          variant: String(entry.orderedItem.variant || 'regular'),
          variantLabel: String(entry.orderedItem.variantLabel || (entry.orderedItem.variant === 'half' ? 'Half' : 'Regular')),
          source: 'clear-table-booking-menu',
        },
      };
    });

    const nextDiningItems = [...existingBillItems, ...generatedBillItems];
    let persisted = true;
    if (nextDiningItems.length) {
      persisted = await persistDiningBill({ ...sourceTable, checkOutTime }, nextDiningItems);
      if (!persisted) {
        for (const rollbackEntry of deductedStock.reverse()) {
          await syncProductStock(rollbackEntry.product, rollbackEntry.qty);
        }
        setMessage({ type: 'error', text: 'Failed to move the table menu into Bill Items.' });
        return;
      }
    }

    const hasPendingDiningBill = nextDiningItems.length > 0;
    const nextTables = tables.map((table) => String(table.id) === normalizedTableId ? {
      ...table,
      status: 'empty',
      guest: '',
      customerMobile: '',
      partySize: 0,
      orderSummary: '',
      orderedMenuItems: [],
      checkInDate: undefined,
      checkInTime: undefined,
      checkOutTime,
    } : table);
    syncDiningTables(nextTables);
    if (String(selectedDiningTable?.id) === normalizedTableId) closeDiningTableBooking();
    if (hasPendingDiningBill) {
      setActiveTab('dining');
      setActiveDiningTableId(normalizedTableId);
    } else if (String(activeDiningTableId) === normalizedTableId) {
      setActiveDiningTableId(null);
    }
    setMessage({
      type: 'success',
      text: hasPendingDiningBill
        ? 'Dining table cleared. This table menu is now available in Bill Items for billing and settlement.'
        : 'Dining table cleared and marked available.',
    });
    try {
      if (!hasPendingDiningBill) {
        await hotelService.clearDiningBill(tableId);
      }
      await hotelService.updateTable(tableId, { status: 'empty', guest: '', customerMobile: '', partySize: 0, orderSummary: '', orderedMenuItems: [], checkInDate: undefined, checkInTime: undefined, checkOutTime });
    } catch (err) {
      showToast('error', 'Failed to sync table clear to server.');
    }
  };

  const handleDiningTableDelete = async (tableId) => {
    const normalizedTableId = String(tableId || '');
    const existingBill = diningBillsByTable[normalizedTableId];
    const nextTables = tables.filter((table) => String(table.id) !== normalizedTableId);
    syncDiningTables(nextTables);
    if (String(selectedDiningTable?.id) === normalizedTableId) closeDiningTableBooking();
    if (String(activeDiningTableId) === normalizedTableId) {
      setActiveDiningTableId(null);
    }
    applyDiningBillLocally({ id: normalizedTableId, name: '', guest: '', partySize: 0, checkInDate: '', checkInTime: '' }, []);
    setMessage({ type: 'success', text: 'Dining table deleted successfully.' });
    try {
      if (Array.isArray(existingBill?.items)) {
        for (const billItem of existingBill.items) {
          const sourceProduct = products.find((product) => String(product.id) === String(billItem.meta?.productId));
          if (sourceProduct) {
            await syncProductStock(sourceProduct, Number(billItem.qty || 0));
          }
        }
      }
      await hotelService.clearDiningBill(tableId);
      await hotelService.deleteTable(tableId);
    } catch (err) {
      showToast('error', 'Failed to delete table from server.');
    }
  };

  const releaseDiningTableAfterBilling = async (tableId) => {
    if (!tableId) return;
    const normalizedTableId = String(tableId);
    // Capture checkout time when table is cleared
    const checkOutTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

    const nextTables = tables.map((table) => String(table.id) === normalizedTableId ? {
      ...table,
      status: 'empty',
      guest: '',
      customerMobile: '',
      partySize: 0,
      orderSummary: '',
      orderedMenuItems: [],
      checkInDate: undefined,
      checkInTime: undefined,
      checkOutTime,
    } : table);

    syncDiningTables(nextTables);
    if (String(activeDiningTableId) === normalizedTableId) {
      setActiveDiningTableId(null);
    }
    if (String(selectedDiningTable?.id) === normalizedTableId) {
      closeDiningTableBooking();
    }

    await hotelService.clearDiningBill(tableId);
    applyDiningBillLocally({ id: tableId, name: '', guest: '', partySize: 0, checkInDate: '', checkInTime: '', checkOutTime }, []);
    await hotelService.updateTable(tableId, {
      checkOutTime,
      status: 'empty',
      guest: '',
      customerMobile: '',
      partySize: 0,
      orderSummary: '',
      orderedMenuItems: [],
      checkInDate: undefined,
      checkInTime: undefined,
    });
  };

  const handleEditFromBilling = (roomId) => {
    try {
      // default behaviour: open Lodging page for full edit
      window.localStorage.setItem('hotel_open_room', roomId);
      navigate('/hotel-lodging');
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to open room editor.' });
    }
  };

  const openQuickEdit = (roomId) => {
    const room = lodgingRooms.find(r => r.id === roomId);
    if (!room) return setMessage({ type: 'error', text: 'Room not found.' });
    if (room.status !== 'occupied') {
      setMessage({ type: 'error', text: 'Quick Edit is available only for occupied rooms.' });
      return;
    }
    // use a shallow copy so edits don't mutate the card until saved
    const draft = { ...room };
    setEditingRoom(draft);
    setEditingRoomErrors({ guest: false, mobile: false, nights: false, members: false, rate: false, gst: false, checkIn: false, idType: false, idNumber: false });
    setShowEditModal(true);
    try {
      window.dispatchEvent(new CustomEvent('hotel_room_draft_started', { detail: { id: roomId, draft } }));
    } catch (e) {
      // ignore
    }
  };

  const openQuickBook = (roomId, details = {}) => {
    const room = lodgingRooms.find(r => r.id === roomId);
    if (!room) return setMessage({ type: 'error', text: 'Room not found.' });
    setQuickBookRoom({ ...room });
    setQbOpenDetails(details || null);
    setQbGuestName(details.guest || '');
    setQbCustomerMobile(details.customerMobile || room.customerMobile || '');
    setQbNights(details.nights || 1);
    setQbMembers(details.members || 1);
    setQbNotes(details.notes || '');
    setQbIdType((details.idProof && details.idProof.type) ? details.idProof.type : (room.idProof && room.idProof.type) ? room.idProof.type : '');
    setQbIdNumber((details.idProof && details.idProof.number) ? details.idProof.number : (room.idProof && room.idProof.number) ? room.idProof.number : '');
    setQbRate((details.rate != null && details.rate !== '') ? String(details.rate) : (room.rate != null ? String(room.rate) : ''));
    setQbGst((details.gst != null && details.gst !== '') ? String(details.gst) : (room.gst != null ? String(room.gst) : ''));
    // default check-in date/time
    const today = new Date();
    const defaultDate = (details.checkInDate) ? details.checkInDate : (room.checkInDate ? room.checkInDate : today.toISOString().slice(0,10));
    const defaultTime = (details.checkInTime) ? details.checkInTime : (room.checkInTime ? room.checkInTime : `${String(today.getHours()).padStart(2,'0')}:${String(today.getMinutes()).padStart(2,'0')}`);
    setQbCheckInDate(defaultDate);
    setQbCheckInTime(defaultTime);
    setQbErrors({ guest: false, mobile: false, nights: false, members: false, rate: false, gst: false, idType: false, idNumber: false });
    setShowQuickBookModal(true);
    try { window.dispatchEvent(new CustomEvent('hotel_room_draft_started', { detail: { id: roomId } })); } catch(e){}
  };

  const handleQuickBook = () => {
    if (!quickBookRoom) return;
    const errs = { guest: false, mobile: false, nights: false, members: false, rate: false, gst: false, idType: false, idNumber: false };
    // include checkIn validation flag
    errs.checkIn = false;
    if (!qbGuestName || !qbGuestName.trim()) errs.guest = true;
    if (!/^\d{10}$/.test(String(qbCustomerMobile || '').trim())) errs.mobile = true;
    const nr = Number(qbNights);
    if (!nr || nr < 1 || nr > 99 || !Number.isInteger(nr)) errs.nights = true;
    const nm = Number(qbMembers);
    const bedCount = Number(quickBookRoom.beds) || 1;
    if (!nm || nm < 1 || nm > bedCount) errs.members = true;

    // determine rate string: prefer explicit qbRate, fall back to room.rate
    const rateSource = (qbRate !== '' && qbRate != null) ? String(qbRate) : (quickBookRoom.rate != null ? String(quickBookRoom.rate) : '');
    if (!/^[0-9]{1,5}$/.test(rateSource) || Number(rateSource) <= 0) errs.rate = true;
    const gstSource = (qbGst !== '' && qbGst != null) ? String(qbGst) : '';
    if (!/^[0-9]{1,2}$/.test(gstSource) || Number(gstSource) < 0 || Number(gstSource) > 99) errs.gst = true;
    if (!String(qbIdType || '').trim()) errs.idType = true;
    if (!String(qbIdNumber || '').trim()) errs.idNumber = true;
    setQbErrors(errs);
    if (errs.guest || errs.mobile || errs.nights || errs.members || errs.rate || errs.gst || errs.idType || errs.idNumber) return setMessage({ type: 'error', text: 'Please fix booking fields.' });
    // require check-in date/time
    if (!qbCheckInDate || !qbCheckInTime) return setMessage({ type: 'error', text: 'Please provide check-in date and time.' });

    // prevent overwriting existing occupied rooms
    const original = lodgingRooms.find(r => r.id === quickBookRoom.id);
    if (original && original.status === 'occupied') {
      setMessage({ type: 'error', text: 'Room is already occupied. Quick Book will not overwrite existing booking.' });
      return;
    }

    const pr = Number(rateSource);
    const gstNum = (qbGst !== '' && qbGst != null) ? Number(qbGst) : 0;

    const updatedRooms = lodgingRooms.map(r => r.id === quickBookRoom.id ? {
      ...r,
      status: 'occupied',
      guest: qbGuestName.trim(),
      customerMobile: String(qbCustomerMobile || '').trim(),
      checkInDate: qbCheckInDate,
      checkInTime: qbCheckInTime,
      nights: nr,
      members: nm,
      notes: qbNotes.trim(),
      rate: pr,
      gst: gstNum,
      idProof: { type: String(qbIdType || '').trim(), number: String(qbIdNumber || '').trim() }
    } : r);

    try {
      setLodgingRooms(updatedRooms);
      window.localStorage.setItem('hotel_lodging_rooms', JSON.stringify(updatedRooms));
      window.dispatchEvent(new CustomEvent('hotel_lodging_rooms_updated', { detail: updatedRooms }));
    } catch (err) { /* ignore */ }

    // add shared item for Billing POS
    try {
      const sharedKey = 'hotel_shared_items';
      let existing = JSON.parse(window.localStorage.getItem(sharedKey) || '[]');
      const gstAmount = 0;
      const sharedItem = buildLodgingBillItem({
        room: quickBookRoom,
        guest: qbGuestName,
        customerMobile: qbCustomerMobile,
        nights: nr,
        rate: pr,
        notes: qbNotes,
        idProof: { type: String(qbIdType || '').trim(), number: String(qbIdNumber || '').trim() },
        checkInDate: qbCheckInDate,
        checkInTime: qbCheckInTime,
        source: 'booking'
      });
      // Replace only the shared item for this room.
      try {
        existing = Array.isArray(existing) ? existing.filter(s => !(s && s.type === 'lodging' && s.meta && s.meta.roomId === quickBookRoom.id)) : [];
      } catch (e) { existing = []; }
      existing.push(sharedItem);
      setItems((prev) => replaceLodgingBillItem(prev, sharedItem));
      window.localStorage.setItem(sharedKey, JSON.stringify(existing));
      window.dispatchEvent(new CustomEvent('hotel_shared_items_updated', { detail: existing }));
    } catch (err) { /* ignore */ }

    // clear draft and close modal
    try { window.dispatchEvent(new CustomEvent('hotel_room_draft_cleared', { detail: { id: quickBookRoom.id } })); } catch(e){}
    setShowQuickBookModal(false);
    setQuickBookRoom(null);
    setShowSyncToast(true);
    setTimeout(() => setShowSyncToast(false), 3000);

    // If this Quick Book originated from an assign (waiting entry), remove that waiting entry locally and on server
    try {
      const waitingId = qbOpenDetails?.waitingId;
      if (waitingId) {
        // remove from local storage waiting list
        try {
          const key = 'hotel_table_booking_waiting_list';
          const raw = window.localStorage.getItem(key) || '[]';
          const parsed = JSON.parse(raw);
          const updated = Array.isArray(parsed) ? parsed.filter(w => w.id !== waitingId) : [];
          window.localStorage.setItem(key, JSON.stringify(updated));
          // notify other components
          try { window.dispatchEvent(new CustomEvent('hotel_waiting_list_updated', { detail: updated })); } catch(e){}
        } catch (err) {}

        // best-effort server removal
        (async () => {
          try { await hotelService.removeWaiting(waitingId); } catch (err) { showToast && showToast('error', 'Failed to remove waiting from server.'); }
          try { await hotelService.updateTable(quickBookRoom.id, updatedRooms.find(r => r.id === quickBookRoom.id) || {}); } catch (err) { /* ignore */ }
        })();
      }
    } catch (err) {}
    setQbOpenDetails(null);
  };

  const saveRoomEdits = () => {
    if (!editingRoom) return;
    // validate booking edits (guest, nights, members, rate, gst)
    const errs = { guest: false, mobile: false, nights: false, members: false, rate: false, gst: false, idType: false, idNumber: false };
    if (!editingRoom.guest || !String(editingRoom.guest).trim()) errs.guest = true;
    if (!/^\d{10}$/.test(String(editingRoom.customerMobile || '').trim())) errs.mobile = true;
    const nightsNum = Number(editingRoom.nights);
    if (!nightsNum || nightsNum < 1 || nightsNum > 99 || !Number.isInteger(nightsNum)) errs.nights = true;
    const membersNum = Number(editingRoom.members);
    const bedCount = Number(editingRoom.beds) || 1;
    if (!membersNum || membersNum < 1 || membersNum > bedCount) errs.members = true;
    const rateStr = String(editingRoom.rate || '');
    // rate must be digits only, up to 5 digits, and > 0 (rupees)
    if (!/^[0-9]{1,5}$/.test(rateStr) || Number(rateStr) <= 0) errs.rate = true;
    const gstStr = editingRoom.gst != null ? String(editingRoom.gst) : '';
    if (!/^[0-9]{1,2}$/.test(gstStr) || Number(gstStr) < 0 || Number(gstStr) > 99) errs.gst = true;
    if (!String(editingRoom.idProof?.type || '').trim()) errs.idType = true;
    if (!String(editingRoom.idProof?.number || '').trim()) errs.idNumber = true;
    setEditingRoomErrors(errs);
    if (errs.guest || errs.mobile || errs.nights || errs.members || errs.rate || errs.gst || errs.checkIn || errs.idType || errs.idNumber) {
      setMessage({ type: 'error', text: 'Fix highlighted booking fields in quick edit.' });
      return;
    }

    const updated = lodgingRooms.map(r => r.id === editingRoom.id ? {
      ...r,
      status: 'occupied',
      guest: String(editingRoom.guest).trim(),
      customerMobile: String(editingRoom.customerMobile || '').trim(),
      checkInDate: editingRoom.checkInDate || r.checkInDate || new Date().toISOString().slice(0,10),
      checkInTime: editingRoom.checkInTime || r.checkInTime || `${String(new Date().getHours()).padStart(2,'0')}:${String(new Date().getMinutes()).padStart(2,'0')}`,
      nights: Number(editingRoom.nights),
      members: Number(editingRoom.members),
      notes: editingRoom.notes || '',
      rate: Number(editingRoom.rate),
      gst: editingRoom.gst != null && editingRoom.gst !== '' ? Number(editingRoom.gst) : 0,
      idProof: editingRoom.idProof ? { type: String(editingRoom.idProof.type || '').trim(), number: String(editingRoom.idProof.number || '').trim() } : undefined
    } : r);

    setLodgingRooms(updated);
    try {
      window.localStorage.setItem('hotel_lodging_rooms', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('hotel_lodging_rooms_updated', { detail: updated }));
    } catch (err) {
      // ignore
    }
    // Update any existing shared billing items for this room to reflect edited GST/rate/notes/idProof
    try {
      const key = 'hotel_shared_items';
      const raw = window.localStorage.getItem(key) || '[]';
      const shared = JSON.parse(raw);
      if (Array.isArray(shared)) {
        // remove any lodging items for this room and replace with a single consolidated item
        const remaining = shared.filter(s => !(s && s.type === 'lodging' && s.meta && s.meta.roomId === editingRoom.id));
        const nights = Number(editingRoom.nights || 1);
        const rate = Number(editingRoom.rate || 0);
        const consolidated = buildLodgingBillItem({
          room: editingRoom,
          guest: editingRoom.guest,
          customerMobile: editingRoom.customerMobile,
          nights,
          rate,
          notes: editingRoom.notes,
          idProof: editingRoom.idProof || undefined,
          checkInDate: editingRoom.checkInDate,
          checkInTime: editingRoom.checkInTime,
          source: 'edit'
        });
        const updatedShared = [...remaining, consolidated];
        setItems((prev) => replaceLodgingBillItem(prev, consolidated));
        window.localStorage.setItem(key, JSON.stringify(updatedShared));
        try { window.dispatchEvent(new CustomEvent('hotel_shared_items_updated', { detail: updatedShared })); } catch(e){}
      }
    } catch (e) {}
    setShowEditModal(false);
    try { window.dispatchEvent(new CustomEvent('hotel_room_draft_cleared', { detail: { id: editingRoom.id } })); } catch(e){}
    setEditingRoom(null);
    setShowSyncToast(true);
    setTimeout(() => setShowSyncToast(false), 3000);
  };


  const handleCheckoutFromBilling = (roomId) => {
    try {
      const roomToCheckout = lodgingRooms.find((room) => room.id === roomId);
      if (roomToCheckout && (roomToCheckout.guest || roomToCheckout.checkIn)) {
        const existingHistory = JSON.parse(window.localStorage.getItem(CHECKOUT_HISTORY_STORAGE_KEY) || '[]');
        const nextHistory = Array.isArray(existingHistory) ? existingHistory : [];
        const historyEntry = {
          id: `checkout-${roomId}-${Date.now()}`,
          roomId: roomToCheckout.id,
          roomName: roomToCheckout.name,
          guest: roomToCheckout.guest || '',
          checkIn: roomToCheckout.checkIn || '',
          nights: Number(roomToCheckout.nights || 1),
          members: Number(roomToCheckout.members || 1),
          rate: Number(roomToCheckout.rate || 0),
          total: Number(roomToCheckout.rate || 0) * Number(roomToCheckout.nights || 1),
          notes: roomToCheckout.notes || '',
          idProof: roomToCheckout.idProof || null,
          checkedOutAt: new Date().toISOString(),
        };
        const updatedHistory = [historyEntry, ...nextHistory].slice(0, 200);
        window.localStorage.setItem(CHECKOUT_HISTORY_STORAGE_KEY, JSON.stringify(updatedHistory));
        try {
          window.dispatchEvent(new CustomEvent('hotel_lodging_checkout_history_updated', { detail: updatedHistory }));
        } catch (e) {
          // ignore
        }
        (async () => {
          try {
            await hotelService.addCheckoutHistory(historyEntry);
          } catch (err) {
            console.warn('Failed to sync checkout history to server', err);
          }
          try {
            await hotelService.checkoutRoom(roomId, {});
          } catch (err) {
            console.warn('Failed to checkout room on server', err);
          }
        })();
      }

      const updated = lodgingRooms.map(r => r.id === roomId ? { ...r, status: 'vacant', guest: '', checkIn: '', nights: 1, members: 1, notes: '', idProof: undefined, gst: 0, customerMobile: '' } : r);
      setLodgingRooms(updated);
      window.localStorage.setItem('hotel_lodging_rooms', JSON.stringify(updated));
      try {
        window.dispatchEvent(new CustomEvent('hotel_lodging_rooms_updated', { detail: updated }));
      } catch (e) {
        // ignore
      }
        // also remove any shared billing item for this room
        try {
          const sharedKey = 'hotel_shared_items';
          const raw = window.localStorage.getItem(sharedKey) || '[]';
          const shared = JSON.parse(raw);
          if (Array.isArray(shared)) {
            const remaining = shared.filter(s => !(s && s.type === 'lodging' && s.meta && s.meta.roomId === roomId));
            window.localStorage.setItem(sharedKey, JSON.stringify(remaining));
            try { window.dispatchEvent(new CustomEvent('hotel_shared_items_updated', { detail: remaining })); } catch(e){}
          }
        } catch (e) {}
      
      // Clear quick book modal and fields
      setShowQuickBookModal(false);
      setQuickBookRoom(null);
      setQbGuestName('');
      setQbCustomerMobile('');
      setQbNights(1);
      setQbMembers(1);
      setQbNotes('');
      setQbIdType('');
      setQbIdNumber('');
      setQbRate('');
      setQbGst('');
      setQbCheckInDate('');
      setQbCheckInTime('');
      
      setMessage({ type: 'success', text: 'Room checked out.' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to checkout room.' });
    }
  };

  const productOptions = products
    .filter((product) => diningCategories.includes(product.category) && product.available !== false)
    .map((product) => ({
      value: product.id || product.name,
      label: `${product.name} • ₹${Number(product.fullPrice || product.price || 0)} • ${product.category || "Dining"}${getDiningStockState(product) === 'out' ? ' • Out of stock' : getDiningStockState(product) === 'low' ? ' • Low stock' : ''}`,
      product,
    }));
  const bookingMenuOptions = productOptions
    .filter((option) => getDiningStockState(option.product) !== 'out')
    .sort((left, right) => String(left.product?.name || '').localeCompare(String(right.product?.name || '')));
  const bookingMenuOptionsByCategory = diningCategories
    .map((category) => ({
      category,
      options: bookingMenuOptions.filter((option) => (option.product?.category || '') === category),
    }))
    .filter((group) => group.options.length > 0);

  const totalTables = tables.length;
  const emptyTables = tables.filter((t) => t.status === "empty").length;
  const bookedTables = tables.filter((t) => t.status === "booked").length;

  const totalRooms = lodgingRooms.length;
  const vacantRooms = lodgingRooms.filter((r) => r.status === 'vacant').length;
  const occupiedRooms = lodgingRooms.filter((r) => r.status === 'occupied').length;
  const bookableRevenue = lodgingRooms.reduce((sum, room) => {
    if (room.status === 'occupied') {
      const nights = Number(room.nights || 1);
      const rate = Number(room.rate || 0);
      return sum + rate * nights;
    }
    return sum;
  }, 0);

  const activeProduct = productOptions.find((option) => option.value === selectedProduct)?.product;
  const activeProductVariants = getDiningProductVariants(activeProduct);
  const activeVariant = activeProductVariants.find((variant) => variant.value === selectedProductVariant) || activeProductVariants[0] || null;
  const activeProductStockState = getDiningStockState(activeProduct);
  const itemPrice = activeProduct ? Number(activeProduct.price || 0) : 0;
  const itemGST = activeProduct ? Number(activeProduct.gst || 0) : 0;
  const activeDiningTable = tables.find((table) => String(table.id) === String(activeDiningTableId)) || null;
  const activeDiningBill = activeDiningTableId ? diningBillsByTable[String(activeDiningTableId)] : null;
  const activeDiningSummary = summarizeDiningBillItems(activeDiningBill?.items) || summarizeOrderedMenuItems(activeDiningTable?.orderedMenuItems) || activeDiningTable?.orderSummary || '';
  const activeDiningCheckIn = [
    activeDiningBill?.checkInDate || activeDiningTable?.checkInDate || '',
    formatTime12Hour(activeDiningBill?.checkInTime || activeDiningTable?.checkInTime || ''),
  ].filter(Boolean).join(' · ');
  const isDiningBillEditable = activeDiningTable?.status === 'booked';
  const getDiningCardSummary = (table) => summarizeDiningBillItems(diningBillsByTable[String(table.id || '')]?.items) || summarizeOrderedMenuItems(table?.orderedMenuItems) || table.orderSummary || '';

  const syncSelectedDiningMenus = (nextMenus) => {
    setSelectedDiningMenus(nextMenus);
    setDiningOrderedMenu(summarizeOrderedMenuItems(nextMenus));
  };

  const handleAddSelectedDiningMenu = () => {
    const selectedOption = bookingMenuOptions.find((option) => String(option.value) === String(selectedDiningMenuProductId));
    if (!selectedOption?.product) return;

    const nextMenus = (() => {
      const existingIndex = selectedDiningMenus.findIndex((item) => String(item.productId || '') === String(selectedOption.product.id || ''));
      if (existingIndex >= 0) {
        return selectedDiningMenus.map((item, index) => index === existingIndex ? { ...item, qty: Number(item.qty || 1) + 1 } : item);
      }
      return [
        ...selectedDiningMenus,
        {
          productId: selectedOption.product.id || undefined,
          name: selectedOption.product.name,
          category: selectedOption.product.category || '',
          qty: 1,
        },
      ];
    })();

    syncSelectedDiningMenus(nextMenus);
    setSelectedDiningMenuProductId('');
  };

  const handleDiningMenuQtyChange = (menuIndex, delta) => {
    const nextMenus = selectedDiningMenus
      .map((item, index) => {
        if (index !== menuIndex) return item;
        return { ...item, qty: Math.max(0, Number(item.qty || 1) + delta) };
      })
      .filter((item) => Number(item.qty || 0) > 0);
    syncSelectedDiningMenus(nextMenus);
  };

  const handleRemoveSelectedDiningMenu = (menuIndex) => {
    syncSelectedDiningMenus(selectedDiningMenus.filter((_, index) => index !== menuIndex));
  };

  useEffect(() => {
    if (!activeProduct) {
      setSelectedProductVariant('regular');
      return;
    }
    const variants = getDiningProductVariants(activeProduct);
    if (!variants.some((variant) => variant.value === selectedProductVariant)) {
      setSelectedProductVariant(variants[0]?.value || 'regular');
    }
  }, [activeProduct, selectedProductVariant]);

  const syncProductStock = async (product, delta) => {
    if (!product?.id) return { ok: false };
    const currentStock = Number(product.stock || 0);
    const nextStock = currentStock + Number(delta || 0);
    if (nextStock < 0) {
      return { ok: false, reason: 'insufficient' };
    }
    try {
      const updated = await updateProductStockApi({ ...product, stock: nextStock });
      setProducts((prev) => prev.map((entry) => (String(entry.id) === String(updated.id) ? updated : entry)));
      return { ok: true, product: updated };
    } catch (error) {
      console.error('Failed to update hotel menu stock', error);
      return { ok: false, reason: 'sync' };
    }
  };

  const addDiningItem = async () => {
    if (!activeProduct) return setMessage({ type: "error", text: "Select a dining item to add." });
    if (!quantity || quantity <= 0) return setMessage({ type: "error", text: "Enter a valid quantity." });
    if (!activeDiningTableId || !activeDiningTable || activeDiningTable.status !== 'booked') {
      return setMessage({ type: "error", text: "Select a booked dining table before adding bill items." });
    }
    if (activeProduct.available === false) {
      return setMessage({ type: "error", text: "This menu item is unavailable." });
    }
    if (activeProductStockState === 'out') {
      return setMessage({ type: "error", text: `${activeProduct.name} is out of stock and cannot be billed.` });
    }

    const billQuantity = Number(quantity);
    if (Number(activeProduct.stock || 0) < billQuantity) {
      return setMessage({ type: "error", text: `Only ${Number(activeProduct.stock || 0)} unit(s) available in stock.` });
    }

    const stockResult = await syncProductStock(activeProduct, -billQuantity);
    if (!stockResult.ok) {
      return setMessage({ type: "error", text: stockResult.reason === 'insufficient' ? 'Insufficient stock for this item.' : 'Failed to update item stock.' });
    }

    const item = {
      id: `${activeDiningTableId}-${activeProduct.id || activeProduct.name}-${Date.now()}`,
      name: activeVariant?.label && activeVariant.value !== 'regular' ? `${activeProduct.name} (${activeVariant.label})` : activeProduct.name,
      type: "dining",
      qty: billQuantity,
      rate: Number(activeVariant?.price ?? activeProduct.price ?? 0),
      gst: itemGST,
      total: billQuantity * Number(activeVariant?.price ?? activeProduct.price ?? 0),
      category: activeProduct.category || "Dining",
      meta: {
        tableId: activeDiningTable.id,
        tableName: activeDiningTable.name,
        guest: activeDiningTable.guest || '',
        partySize: activeDiningTable.partySize || 0,
        productId: activeProduct.id,
        variant: activeVariant?.value || 'regular',
        variantLabel: activeVariant?.label || 'Regular',
      },
    };

    const existingItems = items.filter((existingItem) => existingItem.type === 'dining' && String(existingItem.meta?.tableId || '') === String(activeDiningTableId));
    const nextDiningItems = [...existingItems, item];
    const persisted = await persistDiningBill(activeDiningTable, nextDiningItems);
    if (!persisted) {
      await syncProductStock(stockResult.product || activeProduct, billQuantity);
      return setMessage({ type: 'error', text: 'Failed to save item to the dining bill.' });
    }
    setSelectedProduct("");
    setSelectedProductVariant('regular');
    setQuantity(1);
    setMessage(null);
  };

  const addLodgingCharge = () => {
    const amount = Number(lodgingAmount);
    if (!lodgingDescription.trim()) return setMessage({ type: "error", text: "Enter lodging charge description." });
    if (!amount || amount <= 0) return setMessage({ type: "error", text: "Enter a valid lodging amount." });

    const item = {
      id: `lodging-${Date.now()}`,
      name: lodgingDescription,
      type: "lodging",
      qty: 1,
      rate: amount,
      gst: 0,
      total: amount,
      category: "Lodging",
    };

    setItems((prev) => [...prev, item]);
    setLodgingDescription("");
    setLodgingAmount("");
    
    setMessage(null);
  };

  const removeItem = async (id) => {
    const targetItem = items.find((item) => item.id === id);
    if (targetItem?.type === 'dining' && targetItem.meta?.tableId) {
      const targetTable = tables.find((table) => String(table.id || '') === String(targetItem.meta.tableId || ''));
      if (targetTable) {
        const remaining = items.filter((item) => !(item.type === 'dining' && String(item.meta?.tableId || '') === String(targetItem.meta.tableId || '') && item.id === id));
        const nextDiningItems = remaining.filter((item) => item.type === 'dining' && String(item.meta?.tableId || '') === String(targetItem.meta.tableId || ''));
        const persisted = await persistDiningBill(targetTable, nextDiningItems);
        if (!persisted) {
          setMessage({ type: 'error', text: 'Failed to remove dining item from the bill.' });
          return;
        }
        const sourceProduct = products.find((product) => String(product.id) === String(targetItem.meta?.productId));
        if (sourceProduct) {
          await syncProductStock(sourceProduct, Number(targetItem.qty || 0));
        }
        return;
      }
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  };


  const lodgingCount = items.filter((i) => i.type === "lodging").length;
  const diningCount = items.filter((i) => i.type === "dining").length;

  // only show items and totals relevant to the active POS tab (lodging or dining)
  const filteredItems = items.filter((item) => {
    if (item.type !== activeTab) return false;
    if (activeTab !== 'dining') return true;
    if (!activeDiningTableId) return false;
    return String(item.meta?.tableId || '') === String(activeDiningTableId);
  });
  const subtotal = filteredItems.reduce((sum, item) => sum + item.total, 0);
  const gstAmount = filteredItems.reduce((sum, item) => {
    try {
      if (item.type === 'lodging') {
        const roomId = item.meta?.roomId;
        const room = roomId ? lodgingRooms.find(r => r.id === roomId) : null;
        const gstRate = Number(room?.gst ?? item.gst ?? 0);
        const qty = Number(item.qty || 1);
        const base = Number(item.rate || 0) * qty;
        return sum + (Math.round(base * gstRate) / 100);
      }
      const rateGst = Number(item.gst || 0);
      return sum + (Math.round((Number(item.total || 0) * rateGst)) / 100);
    } catch (e) { return sum; }
  }, 0);
  const grandTotal = subtotal + gstAmount;

  const handleSave = async () => {
    if (!filteredItems.length) {
      return setMessage({ type: "error", text: "Add at least one service item for this POS." });
    }

    const invoiceDate = new Date().toISOString().split("T")[0];
    const invoice = {
      invoiceNo: `HINV-${Date.now()}`,
      date: invoiceDate,
      customerName: activeTab === 'dining' ? (activeDiningBill?.guestName || activeDiningTable?.guest || activeDiningBill?.tableName || activeDiningTable?.name || "Dining Guest") : "Hotel Guest",
      customerId: activeTab === 'dining' ? (activeDiningBill?.tableName || activeDiningTable?.name || activeDiningBill?.tableId || activeDiningTable?.id || "Dining Table") : "Hotel Room",
      items: filteredItems.map((i) => ({ ...i, gst: 0, type: i.type })),
      paymentMode: paymentMode,
      notes,
      subTotal: subtotal,
      gstTotal: gstAmount,
      total: grandTotal,
      grandTotal: grandTotal,
      storeType: "hotel",
      hotelDetails: activeTab === 'dining' ? {
        tableId: activeDiningBill?.tableId || activeDiningTable?.id,
        tableName: activeDiningBill?.tableName || activeDiningTable?.name,
        guestName: activeDiningBill?.guestName || activeDiningTable?.guest,
        partySize: activeDiningBill?.partySize || activeDiningTable?.partySize,
        checkInDate: activeDiningBill?.checkInDate || activeDiningTable?.checkInDate,
        checkInTime: activeDiningBill?.checkInTime || activeDiningTable?.checkInTime,
        orderSummary: activeDiningSummary || undefined,
      } : {},
      createdBy: billedByDisplayName,
      createdAt: new Date().toISOString(),
    };

    try {
      await saveInvoice(invoice);
      setMessage({ type: "success", text: "Hotel bill saved successfully." });
      setNotes("");
      // remove only the saved items (filtered) from the global items list so other POS items remain
      const savedIds = filteredItems.map((i) => i.id);
      setItems((prev) => prev.filter((it) => !savedIds.includes(it.id)));
      if (activeTab === 'dining' && activeDiningTable) {
        await releaseDiningTableAfterBilling(activeDiningTable.id);
      }
      // also remove saved shared items from localStorage
      try {
        const sharedKey = "hotel_shared_items";
        const shared = JSON.parse(window.localStorage.getItem(sharedKey) || "[]");
        const remaining = Array.isArray(shared) ? shared.filter((s) => !savedIds.includes(s.id)) : [];
        window.localStorage.setItem(sharedKey, JSON.stringify(remaining));
      } catch (err) {
        console.warn("Failed to update shared lodging items in storage", err);
      }
    } catch (error) {
      console.error("Hotel billing save failed", error);
      setMessage({ type: "error", text: "Failed to save hotel bill." });
    }
  };

  const generateAndPreview = async () => {
    if (!filteredItems.length) { setMessage({ type: 'error', text: 'Add at least one service item to generate invoice.' }); return; }
    // try to attach guest and room info if available from shared items or lodgingRooms
    const roomItem = filteredItems.find(it => it.meta && it.meta.roomId) || filteredItems.find(it => it.type === 'lodging');
    const roomId = roomItem?.meta?.roomId || null;
    const roomObj = roomId ? lodgingRooms.find(r => r.id === roomId) : null;
    const guestName = roomItem?.meta?.guest || roomObj?.guest || '';
    const roomNumber = roomObj?.name || roomId || '';
    const idProof = roomItem?.meta?.idProof || roomObj?.idProof || null;

    const diningTableForInvoice = activeTab === 'dining' ? activeDiningTable : null;
    const invoiceDate = new Date().toISOString().split("T")[0];
    const invoicePayload = {
      invoiceNo: `HINV-${Date.now()}`,
      date: invoiceDate,
      paymentMode: paymentMode,
      items: filteredItems.map((i) => ({ name: i.name, qty: i.qty || 1, rate: i.rate, total: i.total, gst: 0, category: i.category, type: i.type, meta: i.meta })),
      notes,
      subTotal: subtotal,
      gstTotal: gstAmount,
      grandTotal: grandTotal,
      total: grandTotal,
      storeType: 'hotel',
      hotelDetails: activeTab === 'dining'
        ? {
            tableId: activeDiningBill?.tableId || diningTableForInvoice?.id,
            tableName: activeDiningBill?.tableName || diningTableForInvoice?.name,
            guestName: activeDiningBill?.guestName || diningTableForInvoice?.guest || undefined,
            partySize: activeDiningBill?.partySize || diningTableForInvoice?.partySize || undefined,
            checkInDate: activeDiningBill?.checkInDate || diningTableForInvoice?.checkInDate || undefined,
            checkInTime: activeDiningBill?.checkInTime || diningTableForInvoice?.checkInTime || undefined,
            checkOutTime: activeDiningBill?.checkOutTime || diningTableForInvoice?.checkOutTime || undefined,
            orderSummary: activeDiningSummary || undefined,
            notes: notes || undefined,
          }
        : { guestName: guestName || undefined, roomNumber: roomNumber || undefined, notes: notes || undefined, idProof: idProof || undefined },
      customerName: activeTab === 'dining' ? (activeDiningBill?.guestName || diningTableForInvoice?.guest || activeDiningBill?.tableName || diningTableForInvoice?.name || 'Dining Guest') : (guestName || 'Hotel Guest'),
      customerId: activeTab === 'dining' ? (activeDiningBill?.tableName || diningTableForInvoice?.name || activeDiningBill?.tableId || diningTableForInvoice?.id || 'Dining Table') : (roomNumber || 'Hotel Room'),
      billedBy: billedByDisplayName,
      createdAt: new Date().toISOString(),
    };

    let savedInvoice = null;
    try {
      savedInvoice = await saveInvoice(invoicePayload);
      setMessage({ type: 'success', text: 'Invoice generated.' });
    } catch (err) {
      console.error('Save invoice failed', err);
      setMessage({ type: 'error', text: 'Failed to save invoice to server — opening preview only.' });
    }

    const invoiceToPreview = savedInvoice || invoicePayload;

    // open popup and render preview
    try {
      const w = window.open('', '_blank', 'width=420,height=760');
      if (!w) throw new Error('Popup blocked');
      w.document.write('<!doctype html><html><head><title>Invoice Preview</title></head><body><div id="root"></div></body></html>');
      Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).forEach((node) => {
        try { w.document.head.appendChild(node.cloneNode(true)); } catch (e) {}
      });
      const root = w.document.getElementById('root');
      const reactRoot = ReactDOM.createRoot(root);
      const InvoiceComponent = activeTab === 'dining' ? DiningInvoice : LodgingInvoice;
      reactRoot.render(<InvoiceComponent invoice={invoiceToPreview} isDuplicate={false} />);
      setTimeout(() => { try { w.print(); } catch (e) { console.warn(e); } }, 500);
    } catch (err) {
      console.error('Preview open failed', err);
      setMessage({ type: 'error', text: 'Failed to open print preview. Allow popups.' });
      return;
    }

    // if save succeeded, clear local items and shared items similar to handleSave
    if (savedInvoice) {
      try {
        // Open saved invoice route and let InvoiceView auto-select lodging/dining layout
        const url = `/invoice/${encodeURIComponent(savedInvoice.invoiceNo)}`;
        const w = window.open(url, '_blank', 'width=820,height=1000');
        if (!w) {
          // popup blocked — fall back to rendering in current tab
          window.location.href = url;
        }

        const savedIds = filteredItems.map((i) => i.id);
        setItems((prev) => prev.filter((it) => !savedIds.includes(it.id)));
        if (activeTab === 'dining' && activeDiningTable) {
          await releaseDiningTableAfterBilling(activeDiningTable.id);
        }
        const sharedKey = 'hotel_shared_items';
        const shared = JSON.parse(window.localStorage.getItem(sharedKey) || '[]');
        const remaining = Array.isArray(shared) ? shared.filter((s) => !savedIds.includes(s.id)) : [];
        window.localStorage.setItem(sharedKey, JSON.stringify(remaining));
      } catch (e) {
        console.warn('Cleanup after save failed', e);
      }
    } else {
      // save failed — we already opened a local preview earlier; do not clear items
    }
  };

  return (
    <div className="hotel-billing-page">
      {showSyncToast && (
        <div style={{ position: 'fixed', right: 24, top: 24, zIndex: 1400 }} className="hotel-sync-toast">Rooms synchronized</div>
      )}
      <div className="hotel-billing-header">
        <div>
          <h2><FaBed /> Hotel Billing</h2>
          <p>Record room charges, guest services and print a hotel invoice quickly. Use the lodging menu below to switch between lodging POS and dining POS.</p>
        </div>
        <div className="hotel-billing-meta">
          <div><strong>Logged in as:</strong> {billedByDisplayName || "Guest"}</div>
          <div><strong>Store:</strong> Hotel</div>
        </div>
      </div>

      <div className="hotel-billing-subnav">
        <button
          type="button"
          className={`hotel-subnav-button ${activeTab === "lodging" ? "active" : ""}`}
          onClick={() => setActiveTab("lodging")}
        >
          <FaBed /> Lodging POS
          {lodgingCount > 0 && <span className="pos-badge lodging-badge">{lodgingCount}</span>}
        </button>
        <button
          type="button"
          className={`hotel-subnav-button ${activeTab === "dining" ? "active" : ""}`}
          onClick={() => setActiveTab("dining")}
        >
          <FaUtensils /> Dining POS
          {diningCount > 0 && <span className="pos-badge dining-badge">{diningCount}</span>}
        </button>
        <Link to="/hotel-tables" className="hotel-subnav-button hotel-subnav-link">
          <FaChair /> Table Booking
        </Link>
      </div>
          <div className="hotel-table-status-panel">
        {activeTab === 'lodging' ? (
          <>
            <div className="hotel-status-card status-total">
              <div className="hotel-status-icon"><FaBed /></div>
              <div>
                <div className="hotel-status-title">Total Rooms</div>
                <strong className="hotel-status-value">{totalRooms}</strong>
              </div>
            </div>
            <div className="hotel-status-card status-vacant">
              <div className="hotel-status-icon"><FaDoorOpen /></div>
              <div>
                <div className="hotel-status-title">Vacant</div>
                <strong className="hotel-status-value">{vacantRooms}</strong>
              </div>
            </div>
            <div className="hotel-status-card status-occupied">
              <div className="hotel-status-icon"><FaUserTie /></div>
              <div>
                <div className="hotel-status-title">Occupied</div>
                <strong className="hotel-status-value">{occupiedRooms}</strong>
              </div>
            </div>
            <div className="hotel-status-card status-revenue">
              <div className="hotel-status-icon"><FaRupeeSign /></div>
              <div>
                <div className="hotel-status-title">Bookable Revenue</div>
                <strong className="hotel-status-value">₹{bookableRevenue}</strong>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="hotel-status-card status-total">
              <div className="hotel-status-icon"><FaChair /></div>
              <div>
                <div className="hotel-status-title">Total Tables</div>
                <strong className="hotel-status-value">{totalTables}</strong>
              </div>
            </div>
            <div className="hotel-status-card status-vacant">
              <div className="hotel-status-icon"><FaDoorOpen /></div>
              <div>
                <div className="hotel-status-title">Empty Tables</div>
                <strong className="hotel-status-value">{emptyTables}</strong>
              </div>
            </div>
            <div className="hotel-status-card status-occupied">
              <div className="hotel-status-icon"><FaUserTie /></div>
              <div>
                <div className="hotel-status-title">Booked Tables</div>
                <strong className="hotel-status-value">{bookedTables}</strong>
              </div>
            </div>
            <div className="hotel-status-card hotel-status-link-card status-link">
              <div className="hotel-status-icon"><FaReceipt /></div>
              <div>
                <div className="hotel-status-title">Manage Tables</div>
                <Link to="/hotel-tables" className="hotel-status-link">Open Table Booking</Link>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="hotel-billing-grid">
        <div className="hotel-billing-card hotel-billing-form">
          <div className="hotel-tab-menu">
            <button
              type="button"
              className={`hotel-tab-button ${activeTab === "lodging" ? "active" : ""}`}
              onClick={() => setActiveTab("lodging")}
            >
              <FaBed /> Lodging
              {lodgingCount > 0 && <span className="pos-badge lodging-badge">{lodgingCount}</span>}
            </button>
            <button
              type="button"
              className={`hotel-tab-button ${activeTab === "dining" ? "active" : ""}`}
              onClick={() => setActiveTab("dining")}
            >
              <FaUtensils /> Dining
              {diningCount > 0 && <span className="pos-badge dining-badge">{diningCount}</span>}
            </button>
          </div>

          {activeTab === "lodging" ? (
            <div className="hotel-pos-section hotel-pos-section-lodging">
              <div className="hotel-pos-hero">
                <div>
                  <div className="hotel-pos-eyebrow">Lodging POS</div>
                  <div className="hotel-pos-heading-row">
                    <h3>Room billing and check-in workspace</h3>
                    <span className="hotel-pos-chip">{occupiedRooms} occupied</span>
                  </div>
                  <p>Review room status, check guests in faster, and add manual lodging charges from one focused workspace.</p>
                </div>
                <div className="hotel-pos-hero-stats">
                  <div className="hotel-pos-mini-stat">
                    <span>Vacant rooms</span>
                    <strong>{vacantRooms}</strong>
                  </div>
                  <div className="hotel-pos-mini-stat accent-warm">
                    <span>Revenue view</span>
                    <strong>₹{bookableRevenue}</strong>
                  </div>
                </div>
              </div>
              {/* Quick-add and quick-edit UI injected above the lodging grid */}
              {/* Edit modal */}
              {quickEditEnabled && showEditModal && editingRoom && (
                <div className="hotel-edit-modal-backdrop">
                  <div className="hotel-edit-modal">
                    <h4>Edit booking {editingRoom.name}</h4>
                    <div className="form-grid">
                      <div>
                        <label>Guest name</label>
                        <input className={editingRoomErrors.guest ? 'error-input' : ''} value={editingRoom.guest || ''} onChange={(e) => { setEditingRoom({ ...editingRoom, guest: e.target.value }); setEditingRoomErrors((prev) => ({ ...prev, guest: false })); }} />
                        {editingRoomErrors.guest && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>Guest name is required.</small>}
                      </div>
                      <div>
                        <label>Guest mobile number</label>
                        <input
                          className={editingRoomErrors.mobile ? 'error-input' : ''}
                          inputMode="numeric"
                          maxLength={10}
                          value={editingRoom.customerMobile || ''}
                          onChange={(e) => {
                            setEditingRoom({ ...editingRoom, customerMobile: String(e.target.value || '').replace(/\D/g, '').slice(0, 10) });
                            setEditingRoomErrors((prev) => ({ ...prev, mobile: false }));
                          }}
                          placeholder="Enter 10-digit mobile number"
                        />
                        {editingRoomErrors.mobile && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>Mobile number must be exactly 10 digits.</small>}
                      </div>
                      <div>
                        <label>Nights</label>
                        <input className={editingRoomErrors.nights ? 'error-input' : ''} type="text" inputMode="numeric" value={editingRoom.nights || 1} onChange={(e) => {
                          const digits = String(e.target.value || '').replace(/\D/g, '').slice(0,2);
                          setEditingRoom({ ...editingRoom, nights: digits ? Number(digits) : 1 });
                        }} />
                        
                      </div>
                      <div>
                        <label>Members</label>
                        <input className={editingRoomErrors.members ? 'error-input' : ''} type="text" inputMode="numeric" value={editingRoom.members || 1} onChange={(e) => {
                          const digits = String(e.target.value || '').replace(/\D/g, '').slice(0, 3);
                          const num = digits ? Number(digits) : 1;
                          const bedCount = Number(editingRoom.beds) || 1;
                          setEditingRoom({ ...editingRoom, members: num > bedCount ? bedCount : (num < 1 ? 1 : num) });
                        }} />
                        <div className="field-hint">Max {editingRoom.beds || 1} members for this room.</div>
                      </div>
                      <div>
                        <label>Rate (₹)</label>
                        <input className={editingRoomErrors.rate ? 'error-input' : ''} inputMode="numeric" value={editingRoom.rate != null ? String(editingRoom.rate) : ''} onChange={(e) => {
                          const digits = String(e.target.value || '').replace(/\D/g, '');
                          const truncated = digits.slice(0, 5);
                          setEditingRoom({ ...editingRoom, rate: truncated });
                        }} />
                        
                      </div>
                      <div>
                        <label>GST (%)</label>
                        <input className={editingRoomErrors.gst ? 'error-input' : ''} inputMode="numeric" value={editingRoom.gst != null ? String(editingRoom.gst) : ''} onChange={(e) => {
                          const digits = String(e.target.value || '').replace(/\D/g, '').slice(0,2);
                          setEditingRoom({ ...editingRoom, gst: digits });
                          setEditingRoomErrors((prev) => ({ ...prev, gst: false }));
                        }} />
                        {editingRoomErrors.gst && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>GST is required. Enter a value from 0 to 99.</small>}
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label>Notes</label>
                        <input value={editingRoom.notes || ''} onChange={(e) => setEditingRoom({ ...editingRoom, notes: e.target.value })} />
                      </div>
                      <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8 }}>
                        <div>
                          <label>ID type</label>
                          <select className={editingRoomErrors.idType ? 'error-input' : ''} value={(editingRoom.idProof && editingRoom.idProof.type) || 'Aadhar'} onChange={(e) => { setEditingRoom({ ...editingRoom, idProof: { ...(editingRoom.idProof || {}), type: e.target.value } }); setEditingRoomErrors((prev) => ({ ...prev, idType: false })); }}>
                            <option>Aadhar</option>
                            <option>Passport</option>
                            <option>Driving License</option>
                            <option>Voter ID</option>
                            <option>Other</option>
                          </select>
                          {editingRoomErrors.idType && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>ID proof type is required.</small>}
                        </div>
                        <div>
                          <label>ID number</label>
                          <input className={editingRoomErrors.idNumber ? 'error-input' : ''} placeholder="Enter ID number" value={(editingRoom.idProof && editingRoom.idProof.number) || ''} onChange={(e) => { setEditingRoom({ ...editingRoom, idProof: { ...(editingRoom.idProof || {}), number: e.target.value } }); setEditingRoomErrors((prev) => ({ ...prev, idNumber: false })); }} />
                          {editingRoomErrors.idNumber && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>ID proof number is required.</small>}
                        </div>
                        <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#666' }}>ID proof is required for quick edit.</div>
                      </div>
                    </div>
                    <div className="modal-actions">
                      <button className="product-btn product-btn-secondary" onClick={() => { setShowEditModal(false); if (editingRoom && editingRoom.id) { try { window.dispatchEvent(new CustomEvent('hotel_room_draft_cleared', { detail: { id: editingRoom.id } })); } catch(e){} } setEditingRoom(null); }}>Cancel</button>
                      <button className="product-btn product-btn-primary" onClick={saveRoomEdits}>Save & Sync</button>
                    </div>
                  </div>
                </div>
              )}
              {/* Quick Book modal */}
              {showQuickBookModal && quickBookRoom && (
                <div className="hotel-edit-modal-backdrop hotel-quickbook-backdrop">
                  <div className="hotel-edit-modal hotel-quickbook-modal">
                    <div className="hotel-quickbook-header">
                      <div>
                        <div className="hotel-quickbook-kicker">Room Booking</div>
                        <h4>Quick Book {quickBookRoom.name}</h4>
                        <div className="hotel-quickbook-subtitle">
                          Capacity: {qbOpenDetails?.beds ?? quickBookRoom.beds ?? 1} members · Beds: {quickBookRoom.beds ?? 1}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="hotel-quickbook-close"
                        aria-label="Close quick book modal"
                        onClick={() => { setShowQuickBookModal(false); try { window.dispatchEvent(new CustomEvent('hotel_room_draft_cleared', { detail: { id: quickBookRoom.id } })); } catch(e){} setQuickBookRoom(null); }}
                      >
                        ×
                      </button>
                    </div>
                    <div className="form-grid">
                      <div>
                        <label>Guest name</label>
                        <input className={qbErrors.guest ? 'error-input' : ''} value={qbGuestName} onChange={(e) => { setQbGuestName(e.target.value); setQbErrors((prev) => ({ ...prev, guest: false })); }} />
                        {qbErrors.guest && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>Guest name is required.</small>}
                      </div>
                      <div>
                        <label>Guest mobile number</label>
                        <input
                          className={qbErrors.mobile ? 'error-input' : ''}
                          inputMode="numeric"
                          maxLength={10}
                          value={qbCustomerMobile}
                          onChange={(e) => {
                            setQbCustomerMobile(String(e.target.value || '').replace(/\D/g, '').slice(0, 10));
                            setQbErrors((prev) => ({ ...prev, mobile: false }));
                          }}
                          placeholder="Enter 10-digit mobile number"
                        />
                        {qbErrors.mobile && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>Mobile number must be exactly 10 digits.</small>}
                      </div>
                      <div>
                        <label>Nights</label>
                        <input className={qbErrors.nights ? 'error-input' : ''} type="text" inputMode="numeric" value={qbNights} onChange={(e) => {
                          const digits = String(e.target.value || '').replace(/\D/g, '').slice(0,2);
                          setQbNights(digits ? Number(digits) : 1);
                        }} />
                        
                      </div>
                      <div>
                        <label>Members</label>
                        <input className={qbErrors.members ? 'error-input' : ''} type="text" inputMode="numeric" value={qbMembers} onChange={(e) => {
                          const digits = String(e.target.value || '').replace(/\D/g, '').slice(0, 3);
                          const num = digits ? Number(digits) : 1;
                          const bedCount = Number(quickBookRoom.beds) || 1;
                          setQbMembers(num > bedCount ? bedCount : (num < 1 ? 1 : num));
                        }} />
                        <div className="field-hint">Max {quickBookRoom.beds || 1} members for this room.</div>
                      </div>
                      <div>
                        <label>Rate (₹)</label>
                        <input className={qbErrors.rate ? 'error-input' : ''} inputMode="numeric" value={qbRate} onChange={(e) => {
                          const digits = String(e.target.value || '').replace(/\D/g, '');
                          const truncated = digits.slice(0, 5);
                          setQbRate(truncated);
                        }} />
                        
                      </div>
                      <div>
                        <label>Check-in Date</label>
                        <input type="date" value={qbCheckInDate} onChange={(e) => setQbCheckInDate(e.target.value)} />
                      </div>
                      <div>
                        <label>Check-in Time</label>
                        <input type="time" value={qbCheckInTime} onChange={(e) => setQbCheckInTime(e.target.value)} />
                      </div>
                      <div>
                        <label>GST (%)</label>
                        <input className={qbErrors.gst ? 'error-input' : ''} inputMode="numeric" value={qbGst} onChange={(e) => {
                          const digits = String(e.target.value || '').replace(/\D/g, '');
                          const truncated = digits.slice(0, 2);
                          setQbGst(truncated);
                          setQbErrors((prev) => ({ ...prev, gst: false }));
                        }} />
                        {qbErrors.gst && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>GST is required. Enter a value from 0 to 99.</small>}
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label>Notes</label>
                        <input value={qbNotes} onChange={(e) => setQbNotes(e.target.value)} />
                      </div>
                      <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8 }}>
                        <div>
                          <label>ID type</label>
                          <select className={qbErrors.idType ? 'error-input' : ''} value={qbIdType} onChange={(e) => { setQbIdType(e.target.value); setQbErrors((prev) => ({ ...prev, idType: false })); }}>
                            <option value="">Select ID type</option>
                            <option value="Aadhar">Aadhar</option>
                            <option value="Passport">Passport</option>
                            <option value="Driving License">Driving License</option>
                            <option value="Voter ID">Voter ID</option>
                            <option value="Other">Other</option>
                          </select>
                          {qbErrors.idType && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>ID proof type is required.</small>}
                        </div>
                        <div>
                          <label>ID number</label>
                          <input className={qbErrors.idNumber ? 'error-input' : ''} placeholder="Enter ID number" value={qbIdNumber} onChange={(e) => { setQbIdNumber(e.target.value); setQbErrors((prev) => ({ ...prev, idNumber: false })); }} />
                          {qbErrors.idNumber && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>ID proof number is required.</small>}
                        </div>
                        <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#666' }}>ID proof is required for quick booking.</div>
                      </div>
                    </div>
                    <div className="modal-actions hotel-quickbook-actions">
                      <button className="product-btn product-btn-secondary" onClick={() => { setShowQuickBookModal(false); try { window.dispatchEvent(new CustomEvent('hotel_room_draft_cleared', { detail: { id: quickBookRoom.id } })); } catch(e){} setQuickBookRoom(null); }}>Cancel</button>
                      <button className="product-btn product-btn-primary" onClick={handleQuickBook}>Book & Sync</button>
                    </div>
                  </div>
                </div>
              )}
              <div className="hotel-pos-layout">
                <div className="hotel-pos-panel hotel-pos-panel-main">
                  <div className="hotel-pos-panel-head">
                    <div>
                      <div className="hotel-section-title">Live Room Board</div>
                      <p>Track availability, current guests, pricing, and checkout actions at a glance.</p>
                    </div>
                    <span className="hotel-pos-chip subtle">{lodgingRooms.length} rooms</span>
                  </div>
                  <div className="hotel-table-grid">
                    {lodgingRooms.map((room) => (
                      <div key={room.id} className={`hotel-table-card ${room.status}`}>
                        {room.status === "occupied" && <div className="hotel-table-ribbon">Occupied</div>}
                        <div className="hotel-table-card-top">
                          <div>
                            <span className="hotel-table-name">{room.name}</span>
                            {editingRoom && editingRoom.id === room.id && (
                              <span className="hotel-card-draft-badge">Editing</span>
                            )}
                            <span className="hotel-table-seats">{room.beds} beds</span>
                            <div className="hotel-room-tags">
                              <span className="hotel-room-chip">{room.ac || 'AC'}</span>
                              {room.modern && <span className="hotel-room-chip success">Modern</span>}
                            </div>
                          </div>
                          <span className={`hotel-table-status-pill ${room.status}`}>{room.status === "occupied" ? "Occupied" : "Vacant"}</span>
                        </div>
                        <div className="hotel-room-state-chips">
                          {room.status === 'occupied' ? (
                            <>
                              <span className="hotel-room-state-chip">
                                <FaUserTie /> {room.guest || 'Guest'}
                              </span>
                              <span className="hotel-room-state-chip">
                                <FaDoorOpen /> {room.checkIn || 'Checked in'}
                              </span>
                              <span className="hotel-room-state-chip">
                                <FaBed /> {room.nights} night{room.nights === 1 ? '' : 's'}
                              </span>
                            </>
                          ) : (
                            <span className="hotel-room-state-chip available">
                              <FaCheckCircle /> Available
                            </span>
                          )}
                        </div>
                        <div className="hotel-table-card-body">
                          {room.status === "occupied" ? (
                            <>
                              <p><strong>Guest:</strong> {room.guest}</p>
                              <p><strong>Mobile:</strong> {room.customerMobile || '—'}</p>
                              <p><strong>Check-in:</strong> {room.checkIn}</p>
                              <p><strong>Nights:</strong> {room.nights}</p>
                              <p><strong>Members:</strong> {room.members}</p>
                            </>
                          ) : (
                            <p>Ready for new check-in</p>
                          )}
                          <p><strong>Rate:</strong> ₹{room.rate}</p>
                          <p><strong>GST:</strong> {room.gst != null && room.gst !== '' ? `${room.gst}%` : '—'}</p>
                          <p className="hotel-ordered-menu"><strong>Notes:</strong> {room.notes || "No notes"}</p>
                          <p><strong>ID Proof:</strong> {room.idProof && (room.idProof.type || room.idProof.number) ? `${room.idProof.type}: ${room.idProof.number}` : '—'}</p>
                        </div>
                        <div className="hotel-table-actions">
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            {quickEditEnabled && room.status === 'occupied' && (
                              <button className="product-btn product-btn-outline hotel-quick-edit-button" type="button" onClick={() => openQuickEdit(room.id)}>
                                Quick Edit
                              </button>
                            )}
                            {room.status !== 'occupied' && (
                              <button className="product-btn product-btn-primary" type="button" onClick={() => openQuickBook(room.id)}>
                                Quick Book
                              </button>
                            )}
                          </div>
                          {room.status === 'occupied' && (
                            <button className="product-btn product-btn-danger" type="button" onClick={() => handleCheckoutFromBilling(room.id)}>
                              Checkout
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>

              <div className="hotel-pos-panel hotel-charge-panel">
                <div className="hotel-pos-panel-head">
                  <div>
                    <div className="hotel-section-title">Add Lodging Charge</div>
                    <p>Add extra charges like late checkout, service fees, or custom room adjustments.</p>
                  </div>
                </div>
                <div className="hotel-form-split">
                  <div className="hotel-field-row">
                    <label>Description</label>
                    <input
                      value={lodgingDescription}
                      onChange={(e) => setLodgingDescription(e.target.value)}
                      placeholder="Room charge, service charge, late checkout"
                    />
                  </div>
                  <div className="hotel-field-row">
                    <label>Amount</label>
                    <input
                      type="number"
                      min="0"
                      value={lodgingAmount}
                      onChange={(e) => setLodgingAmount(e.target.value)}
                      placeholder="Enter amount"
                    />
                  </div>
                </div>
                <div className="hotel-add-actions">
                  <button type="button" className="btn-add-item" onClick={addLodgingCharge}><FaPlus /> Add Lodging Charge</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="hotel-pos-section hotel-pos-section-dining">
              <div className="hotel-pos-hero dining">
                <div>
                  <div className="hotel-pos-eyebrow">Dining POS</div>
                  <div className="hotel-pos-heading-row">
                    <h3>Floor service and live table billing</h3>
                    <span className="hotel-pos-chip dining">{bookedTables} active tables</span>
                  </div>
                  <p>Manage active tables, attach menu items quickly, and keep service teams aligned with one clean dining console.</p>
                </div>
                <div className="hotel-pos-hero-stats">
                  <div className="hotel-pos-mini-stat dining">
                    <span>Empty tables</span>
                    <strong>{emptyTables}</strong>
                  </div>
                  <div className="hotel-pos-mini-stat accent-gold">
                    <span>Open bill items</span>
                    <strong>{activeDiningBill?.openItemCount || 0}</strong>
                  </div>
                </div>
              </div>

              <div className="hotel-status-chip-row" style={{ marginBottom: 18 }}>
                <div className="hotel-status-chip available"><FaTable /> Total Tables: {tables.length}</div>
                <div className="hotel-status-chip available"><FaCheckCircle /> Available: {emptyTables}</div>
                <div className="hotel-status-chip occupied"><FaChair /> Occupied: {bookedTables}</div>
              </div>

              <div className="hotel-pos-panel hotel-dining-brief" style={{ marginBottom: 18, borderStyle: activeDiningTable ? 'solid' : 'dashed' }}>
                <div className="hotel-pos-panel-head">
                  <div>
                    <div className="hotel-section-title">Table Billing</div>
                    <p>Use the active table context below to add menu items to the correct dining bill.</p>
                  </div>
                </div>
                {activeDiningTable ? (
                  <div>
                    <div className="hotel-item-meta" style={{ marginBottom: 8 }}>
                      Billing table: {activeDiningBill?.tableName || activeDiningTable.name} · Guest: {activeDiningBill?.guestName || activeDiningTable.guest || 'Walk-in'} · Party: {activeDiningBill?.partySize || activeDiningTable.partySize || 0}
                    </div>
                    {activeDiningCheckIn && <div className="hotel-item-meta">Check-in: {activeDiningCheckIn}</div>}
                    {activeDiningTable.customerMobile && <div className="hotel-item-meta">Mobile: {activeDiningTable.customerMobile}</div>}
                    <div className="hotel-item-meta">Open bill: {activeDiningBill?.openItemCount || 0} item(s) · ₹{Number(activeDiningBill?.totalAmount || 0).toFixed(2)}</div>
                    {activeDiningSummary && <div className="hotel-item-meta">Items: {activeDiningSummary}</div>}
                    <div className="hotel-item-meta" style={{ marginTop: 8 }}>Choose a dining item below and add it to this table bill.</div>
                  </div>
                ) : (
                  <div className="hotel-empty-state" style={{ padding: 0 }}>
                    1. Book a table. 2. Click the booked table card. 3. Select a dining item and add it to the bill.
                  </div>
                )}
              </div>

              {selectedDiningTable && (
                <div className="hotel-edit-modal-backdrop">
                  <div className="hotel-edit-modal">
                    <h4>{isEditingDiningTable ? `Edit ${selectedDiningTable.name}` : `Book ${selectedDiningTable.name}`}</h4>
                    <div className="form-grid">
                      {isEditingDiningTable && (
                        <>
                          <div>
                            <label>Table name</label>
                            <input value={editDiningTableName} onChange={(e) => setEditDiningTableName(e.target.value)} />
                          </div>
                          <div>
                            <label>Seats</label>
                            <select value={editDiningTableSeats} onChange={(e) => setEditDiningTableSeats(Number(e.target.value))}>
                              {[2, 4, 6, 8, 10].map((seatCount) => (
                                <option key={seatCount} value={seatCount}>{seatCount} seats</option>
                              ))}
                            </select>
                          </div>
                          <div style={{ gridColumn: '1 / -1' }}>
                            <label>Zone</label>
                            <select value={editDiningTableZone} onChange={(e) => setEditDiningTableZone(e.target.value)}>
                              {['Main', 'Window', 'Garden', 'Terrace'].map((zone) => (
                                <option key={zone} value={zone}>{zone}</option>
                              ))}
                            </select>
                          </div>
                        </>
                      )}
                      <div>
                        <label>Guest name</label>
                        <input
                          className={diningGuestError ? 'error-input' : ''}
                          value={diningGuestName}
                          onChange={(e) => {
                            setDiningGuestName(e.target.value);
                            setDiningGuestError('');
                          }}
                          placeholder="Guest name"
                        />
                        {diningGuestError && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>{diningGuestError}</small>}
                      </div>
                      <div>
                        <label>Customer mobile number</label>
                        <input
                          type="tel"
                          inputMode="numeric"
                          className={diningMobileError ? 'error-input' : ''}
                          value={diningCustomerMobile}
                          onChange={(e) => {
                            setDiningCustomerMobile(e.target.value.replace(/[^0-9]/g, '').slice(0, 10));
                            setDiningMobileError('');
                          }}
                          placeholder="Enter mobile number"
                        />
                        {diningMobileError && <small style={{ color: '#d11a2a', display: 'block', marginTop: 4 }}>{diningMobileError}</small>}
                      </div>
                      <div>
                        <label>Party Size</label>
                        <input
                          type="number"
                          min="1"
                          max={selectedDiningTable.seats}
                          value={diningPartySize}
                          onChange={(e) => {
                            const value = Number(e.target.value);
                            const clamped = Number.isNaN(value)
                              ? 1
                              : Math.max(1, Math.min(value, Number(selectedDiningTable.seats || 1)));
                            setDiningPartySize(clamped);
                          }}
                        />
                        <div className="field-hint">Allowed seats: 1 to {selectedDiningTable.seats}.</div>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label>Ordered menu</label>
                        <div className="hotel-booking-menu-picker">
                          <select value={selectedDiningMenuProductId} onChange={(e) => setSelectedDiningMenuProductId(e.target.value)}>
                            <option value="">Select Hotel Menu item</option>
                            {bookingMenuOptionsByCategory.map((group) => (
                              <optgroup key={group.category} label={group.category}>
                                {group.options.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <button className="product-btn product-btn-primary" type="button" onClick={handleAddSelectedDiningMenu} disabled={!selectedDiningMenuProductId}>
                            Add Menu
                          </button>
                        </div>
                        <div className="field-hint">Menu items added in Hotel Menu are shown here so users can select them directly instead of typing a text summary.</div>
                        {selectedDiningMenus.length > 0 ? (
                          <div className="hotel-booking-menu-list">
                            {selectedDiningMenus.map((menuItem, index) => (
                              <div key={`${menuItem.productId || menuItem.name}-${index}`} className="hotel-booking-menu-chip">
                                <div>
                                  <strong>{menuItem.name}</strong>
                                  {menuItem.category && <span>{menuItem.category}</span>}
                                </div>
                                <div className="hotel-booking-menu-chip-actions">
                                  <button type="button" onClick={() => handleDiningMenuQtyChange(index, -1)}>-</button>
                                  <span>{Math.max(1, Number(menuItem.qty || 1))}</span>
                                  <button type="button" onClick={() => handleDiningMenuQtyChange(index, 1)}>+</button>
                                  <button type="button" onClick={() => handleRemoveSelectedDiningMenu(index)}>Remove</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="hotel-booking-menu-empty">
                            {bookingMenuOptions.length > 0 ? 'No menu item selected yet.' : 'No available Hotel Menu items found. Add items in Hotel Menu first.'}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="modal-actions">
                      <button className="product-btn product-btn-secondary" type="button" onClick={closeDiningTableBooking}>Cancel</button>
                      <button className="product-btn product-btn-primary" type="button" onClick={handleDiningTableBook}>{isEditingDiningTable ? 'Update Table' : 'Confirm Booking'}</button>
                    </div>
                  </div>
                </div>
              )}

              <div className="hotel-pos-panel hotel-pos-panel-main" style={{ marginBottom: 18 }}>
                <div className="hotel-pos-panel-head">
                  <div>
                    <div className="hotel-section-title">Dining Floor Map</div>
                    <p>Pick a table card to view or add billing items, or book a new guest on an open table.</p>
                  </div>
                </div>
              <div className="hotel-table-grid">
                {tables.map((table) => (
                  <div
                    key={table.id}
                    className={`hotel-table-card ${table.status} ${(String(activeDiningTableId) === String(table.id) || String(selectedDiningTable?.id) === String(table.id)) ? 'selected' : ''}`}
                    onClick={table.status === 'booked' || (diningBillsByTable[String(table.id || '')]?.items?.length > 0) ? () => setActiveDiningTableId(String(table.id || '')) : undefined}
                    role={table.status === 'booked' || (diningBillsByTable[String(table.id || '')]?.items?.length > 0) ? 'button' : undefined}
                    tabIndex={table.status === 'booked' || (diningBillsByTable[String(table.id || '')]?.items?.length > 0) ? 0 : undefined}
                    onKeyDown={table.status === 'booked' || (diningBillsByTable[String(table.id || '')]?.items?.length > 0) ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setActiveDiningTableId(String(table.id || ''));
                      }
                    } : undefined}
                  >
                    {table.status === "booked" && (
                      <div className="hotel-table-ribbon">Booked</div>
                    )}
                    <div className="hotel-table-card-top">
                      <div>
                        <span className="hotel-table-name">{table.name}</span>
                        <span className="hotel-table-seats">{table.seats} seater</span>
                      </div>
                      <span className={`hotel-table-status-pill ${table.status}`}>{table.status === "booked" ? "Occupied" : "Available"}</span>
                    </div>
                    <div className="hotel-table-card-body">
                      {table.status === "booked" ? (
                        <>
                          <p><strong>Guest:</strong> {table.guest}</p>
                          {(table.checkInDate || table.checkInTime) && <p><strong>Check-in:</strong> {[table.checkInDate || '', formatTime12Hour(table.checkInTime || '')].filter(Boolean).join(' · ')}</p>}
                          <p className="hotel-ordered-menu"><strong>Order:</strong> {getDiningCardSummary(table) || "Not specified"}</p>
                        </>
                      ) : (
                        <p>Ready for new guests</p>
                      )}
                      <p>Party size: {table.partySize || "—"} / {table.seats}</p>
                      <div className={`hotel-table-zone zone-${table.zone.toLowerCase()}`}>
                        <FaMapMarkerAlt /> {table.zone}
                      </div>
                      {table.status === "empty" && waitingQueue.some((entry) => table.seats >= entry.seats) && (
                        <div className="hotel-table-suitable-tag">
                          Suitable for waiting guest{waitingQueue.filter((entry) => table.seats >= entry.seats).length > 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                    <div className="hotel-table-capacity-bar">
                      <div className="hotel-table-capacity-track">
                        <div
                          className="hotel-table-capacity-fill"
                          style={{ width: `${Math.min((table.partySize / table.seats) * 100, 100)}%` }}
                        />
                      </div>
                      <span>{table.partySize}/{table.seats} seated</span>
                    </div>
                    <div className="hotel-table-actions">
                      {table.status === 'booked' && (
                        <button className="product-btn product-btn-secondary" type="button" onClick={(event) => { event.stopPropagation(); openDiningTableEdit(table); }} title="Edit booking">
                          <FaEdit /> Edit Booking
                        </button>
                      )}
                      {table.status === 'empty' ? (
                        <button className="product-btn product-btn-primary" type="button" onClick={(event) => { event.stopPropagation(); openDiningTableBooking(table); }}>
                          Book Table
                        </button>
                      ) : (
                        <button className="product-btn product-btn-danger" type="button" onClick={(event) => { event.stopPropagation(); handleDiningTableClear(table.id); }}>
                          Clear Table
                        </button>
                      )}
                      <button className="product-btn product-btn-danger-outline" type="button" onClick={(event) => { event.stopPropagation(); handleDiningTableDelete(table.id); }}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              </div>

              <div className="hotel-pos-panel hotel-charge-panel">
              <div className="hotel-pos-panel-head">
                <div>
                  <div className="hotel-section-title">Add Dining Item</div>
                  <p>Send food and beverage items to the active table bill with clear product, variant, and quantity controls.</p>
                </div>
              </div>
              <div className="hotel-item-meta hotel-context-strip" style={{ marginBottom: 10 }}>
                {activeDiningTable
                  ? `${isDiningBillEditable ? 'Adding items to' : 'Viewing cleared bill for'} ${activeDiningBill?.tableName || activeDiningTable.name}${activeDiningBill?.guestName || activeDiningTable.guest ? ` · ${activeDiningBill?.guestName || activeDiningTable.guest}` : ''}`
                  : 'Select a booked table card first. Billing items are always added table-wise.'}
              </div>
              <div className="hotel-form-split hotel-form-split-wide">
                <div className="hotel-field-row">
                  <label>Select dining item</label>
                  <select value={selectedProduct} onChange={(e) => setSelectedProduct(e.target.value)} disabled={!isDiningBillEditable}>
                    <option value="">Choose a dining product</option>
                    {productOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              {activeProduct && (
                <>
                  <div className="hotel-field-row hotel-field-row-info">
                  <div className="hotel-item-meta" style={{ marginBottom: 10 }}>
                    {activeProduct.description || 'No menu description available.'}
                  </div>
                  <div className="hotel-item-meta" style={{ marginBottom: 10, color: activeProductStockState === 'out' ? '#b42318' : activeProductStockState === 'low' ? '#b54708' : '#067647', fontWeight: 600 }}>
                    {activeProductStockState === 'out'
                      ? `Out of stock: ${activeProduct.name} cannot be added to the bill.`
                      : activeProductStockState === 'low'
                        ? `Low stock: only ${Number(activeProduct.stock || 0)} unit(s) left.`
                        : `Available stock: ${Number(activeProduct.stock || 0)} unit(s).`}
                  </div>
                      </div>
                  <div className="hotel-field-row small-row">
                    <label>Variant</label>
                    <select value={selectedProductVariant} onChange={(e) => setSelectedProductVariant(e.target.value)} disabled={!isDiningBillEditable}>
                      {activeProductVariants.map((variant) => (
                        <option key={variant.value} value={variant.value}>{variant.label} • ₹{variant.price}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              <div className="hotel-field-row small-row">
                <label>Quantity</label>
                <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} disabled={!isDiningBillEditable} />
              </div>
              </div>
              <div className="hotel-add-actions">
                <button type="button" className="btn-add-item" onClick={addDiningItem} disabled={!isDiningBillEditable || activeProductStockState === 'out'}><FaPlus /> Add To Table Bill</button>
              </div>
              </div>
            </div>
          )}
        </div>

        <div className="hotel-billing-card hotel-billing-items">
          <div className="hotel-section-title">Bill Items</div>
          {filteredItems.length === 0 ? (
            <div className="hotel-empty-state">No items for this POS. Add charges from the service list.</div>
          ) : (
            <div className="hotel-items-list">
              {filteredItems.map((item) => {
                const roomId = item.meta && item.meta.roomId;
                const roomName = roomId ? (lodgingRooms.find(r => r.id === roomId)?.name || roomId) : null;
                return (
                <div key={item.id} className="hotel-item-row">
                  <div>
                    <div className="hotel-item-name">{item.name}</div>
                    {item.type === 'lodging' ? (
                      (() => {
                        const roomId = item.meta?.roomId;
                        const room = roomId ? lodgingRooms.find(r => r.id === roomId) : null;
                        const gstRate = Number(room?.gst ?? 0);
                        const qty = Number(item.qty || 1);
                        const base = Number(item.rate || 0) * qty;
                        const gstAmt = Math.round(base * gstRate) / 100;
                        const nights = Number(item.meta?.nights || room?.nights || 1);
                        const roomRate = Number(item.meta?.roomRate || 0);
                        return (
                          <div className="hotel-item-meta">Guest: {item.meta?.guest || '-'}{roomName ? ` · Room: ${roomName}` : ''} · Qty: {item.qty}{nights > 0 ? ` · Nights: ${nights}` : ''}{roomRate > 0 ? ` · Room Rate: ₹${roomRate}` : ''} {gstRate ? `· GST ${gstRate}% | ₹${gstAmt.toFixed(2)}` : ''}</div>
                        );
                      })()
                    ) : (
                      <div className="hotel-item-meta">Table: {item.meta?.tableName || '-'} · Guest: {item.meta?.guest || '-'} · Qty: {item.qty} · Rate: ₹{item.rate}</div>
                    )}
                  </div>
                  <div className="hotel-item-actions">
                    <div className="hotel-item-total">₹{item.total.toFixed(2)}</div>
                    <button type="button" className="btn-remove-item" onClick={() => removeItem(item.id)}><FaTrash /></button>
                  </div>
                </div>
                );
              })}
            </div>
          )}

          <div className="hotel-summary-card">
            <div><span>Subtotal</span><span>₹{subtotal.toFixed(2)}</span></div>
            <div><span>GST</span><span>₹{gstAmount.toFixed(2)}</span></div>
            <div className="hotel-summary-total"><strong>Total</strong><strong>₹{grandTotal.toFixed(2)}</strong></div>
          </div>

          <div className="hotel-summary-actions">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginRight: 8 }}>
              <span style={{ fontSize: 13 }}>Payment</span>
              <select value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
                <option>Cash</option>
                <option>UPI</option>
                <option>Card</option>
              </select>
            </label>
            <button type="button" className="btn-print-bill" onClick={generateAndPreview}><FaReceipt /> Generate Invoice</button>
          </div>
          {message && (
            <div className={`hotel-message ${message.type}`}>{message.text}</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default HotelBilling;
