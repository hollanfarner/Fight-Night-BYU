const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const DATA_DIR = path.join(__dirname, "data");
const ORDERS_PATH = path.join(DATA_DIR, "orders.json");
const CONTRIBUTIONS_PATH = path.join(DATA_DIR, "contributions.json");

const TICKET_ITEM = "Second Round Ticket";
const TOTAL_TICKETS = 20;
const TICKET_PRICE = 15;
const FIGHTERS = ["Scott Swain", "Dante Richardson"];

app.use(express.json());
app.use(express.static(__dirname));

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (CORS_ORIGINS.includes(origin)) {
    return true;
  }

  if (/^https?:\/\/localhost(?::\d+)?$/i.test(origin)) {
    return true;
  }

  if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) {
    return true;
  }

  return false;
}

app.use((req, res, next) => {
  const origin = req.get("origin");

  if (isAllowedOrigin(origin)) {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

function readAdminKey(req) {
  const headerKey = req.get("x-admin-key");
  const queryKey = req.query?.key;
  return String(headerKey || queryKey || "").trim();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({ error: "Admin key is not configured on the server." });
  }

  const candidate = readAdminKey(req);
  if (!candidate || candidate !== ADMIN_KEY) {
    return res.status(401).json({ error: "Invalid admin key." });
  }

  next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function readJsonArray(filePath) {
  try {
    const file = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(file);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    // Keep the app running if data files are temporarily malformed.
    if (error instanceof SyntaxError) {
      console.warn(`Invalid JSON in ${path.basename(filePath)}. Falling back to an empty list.`);
      return [];
    }

    throw error;
  }
}

async function readOrders() {
  return readJsonArray(ORDERS_PATH);
}

async function writeOrders(orders) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ORDERS_PATH, JSON.stringify(orders, null, 2));
}

async function readContributions() {
  return readJsonArray(CONTRIBUTIONS_PATH);
}

async function writeContributions(contributions) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONTRIBUTIONS_PATH, JSON.stringify(contributions, null, 2));
}

function soldTicketCount(orders) {
  return orders.reduce((sum, order) => sum + Number(order.quantity || 0), 0);
}

function remainingTickets(orders) {
  return Math.max(0, TOTAL_TICKETS - soldTicketCount(orders));
}

function fighterTotals(contributions) {
  const totals = { scott: 0, dante: 0 };

  for (const contribution of contributions) {
    const dollars = Number(contribution.amount || 0);
    if (contribution.fighter === FIGHTERS[0]) {
      totals.scott += dollars;
    }
    if (contribution.fighter === FIGHTERS[1]) {
      totals.dante += dollars;
    }
  }

  return totals;
}

app.get("/api/status", asyncRoute(async (_req, res) => {
  const orders = await readOrders();
  const contributions = await readContributions();
  const sold = soldTicketCount(orders);
  const fighters = fighterTotals(contributions);
  const leader =
    fighters.scott === fighters.dante
      ? "Tie"
      : fighters.scott > fighters.dante
        ? FIGHTERS[0]
        : FIGHTERS[1];

  res.json({
    item: TICKET_ITEM,
    totalTickets: TOTAL_TICKETS,
    sold,
    remaining: Math.max(0, TOTAL_TICKETS - sold),
    price: TICKET_PRICE,
    fighterTotals: fighters,
    leader
  });
}));

app.get("/api/orders", requireAdmin, asyncRoute(async (_req, res) => {
  const orders = await readOrders();
  res.json({ orders });
}));

app.get("/api/contributions", requireAdmin, asyncRoute(async (_req, res) => {
  const contributions = await readContributions();
  res.json({ contributions });
}));

app.get("/api/admin/overview", requireAdmin, asyncRoute(async (_req, res) => {
  const orders = await readOrders();
  const contributions = await readContributions();
  const sold = soldTicketCount(orders);
  const remaining = remainingTickets(orders);
  const totals = fighterTotals(contributions);

  res.json({
    status: {
      item: TICKET_ITEM,
      totalTickets: TOTAL_TICKETS,
      sold,
      remaining,
      price: TICKET_PRICE
    },
    fighterTotals: totals,
    orders,
    contributions
  });
}));

app.post("/api/admin/reset", requireAdmin, asyncRoute(async (req, res) => {
  const target = String(req.body?.target || "all").trim().toLowerCase();
  const validTargets = new Set(["all", "orders", "contributions"]);

  if (!validTargets.has(target)) {
    return res.status(400).json({ error: "Invalid reset target." });
  }

  const ordersBefore = await readOrders();
  const contributionsBefore = await readContributions();

  if (target === "all" || target === "orders") {
    await writeOrders([]);
  }

  if (target === "all" || target === "contributions") {
    await writeContributions([]);
  }

  return res.json({
    message: "Reset complete.",
    cleared: {
      orders: target === "all" || target === "orders" ? ordersBefore.length : 0,
      contributions: target === "all" || target === "contributions" ? contributionsBefore.length : 0
    }
  });
}));

app.post("/api/orders", asyncRoute(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const item = String(req.body?.item || "").trim();
  const fighter = String(req.body?.fighter || "").trim();
  const quantity = Number(req.body?.quantity);

  if (!name) {
    return res.status(400).json({ error: "Name is required." });
  }

  if (item !== TICKET_ITEM) {
    return res.status(400).json({ error: "Only second round tickets are available." });
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: "Quantity must be a whole number of at least 1." });
  }

  if (!FIGHTERS.includes(fighter)) {
    return res.status(400).json({ error: "Please choose a fighter to back." });
  }

  const orders = await readOrders();
  const remaining = remainingTickets(orders);

  if (quantity > remaining) {
    return res.status(409).json({
      error: `Only ${remaining} ticket(s) remain.`,
      remaining
    });
  }

  const order = {
    id: crypto.randomUUID(),
    name,
    item,
    fighter,
    quantity,
    pricePerTicket: TICKET_PRICE,
    totalPrice: quantity * TICKET_PRICE,
    submittedAt: new Date().toISOString()
  };

  orders.push(order);
  await writeOrders(orders);

  return res.status(201).json({
    message: "Order saved.",
    order,
    remaining: remainingTickets(orders)
  });
}));

app.post("/api/contributions", asyncRoute(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const fighter = String(req.body?.fighter || "").trim();
  const amount = Number(req.body?.amount);

  if (!name) {
    return res.status(400).json({ error: "Name is required." });
  }

  if (!FIGHTERS.includes(fighter)) {
    return res.status(400).json({ error: "Please choose a valid fighter." });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Amount must be a number greater than 0." });
  }

  const roundedAmount = Math.round(amount * 100) / 100;
  const contributions = await readContributions();

  const contribution = {
    id: crypto.randomUUID(),
    name,
    fighter,
    amount: roundedAmount,
    submittedAt: new Date().toISOString()
  };

  contributions.push(contribution);
  await writeContributions(contributions);

  return res.status(201).json({
    message: "Contribution saved.",
    contribution
  });
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

const server = app.listen(PORT, () => {
  console.log(`PILF ticket server running on http://localhost:${PORT}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the existing server process, then try again.`);
    process.exit(1);
    return;
  }

  throw error;
});
