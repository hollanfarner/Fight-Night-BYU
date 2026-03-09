const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const ORDERS_PATH = path.join(DATA_DIR, "orders.json");
const CONTRIBUTIONS_PATH = path.join(DATA_DIR, "contributions.json");

const TICKET_ITEM = "Second Round Ticket";
const TOTAL_TICKETS = 20;
const TICKET_PRICE = 15;
const FIGHTERS = ["Scott Swain", "Dante Richardson"];

app.use(express.json());
app.use(express.static(__dirname));

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

app.get("/api/orders", asyncRoute(async (_req, res) => {
  const orders = await readOrders();
  res.json({ orders });
}));

app.get("/api/contributions", asyncRoute(async (_req, res) => {
  const contributions = await readContributions();
  res.json({ contributions });
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
