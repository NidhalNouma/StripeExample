const express = require("express");
const app = express();
const { resolve } = require("path");
const bodyParser = require("body-parser");
require("dotenv").config({ path: "./.env" });

const {
  findUser,
  addUser,
  addIP,
  removeIP,
  findIP,
  addResult,
} = require("./DynamoDb");

if (
  !process.env.STRIPE_SECRET_KEY ||
  !process.env.STRIPE_PUBLISHABLE_KEY ||
  !process.env.FOREX ||
  !process.env.CRYPTO ||
  !process.env.INDICES ||
  !process.env.STOCK ||
  !process.env.STATIC_DIR
) {
  console.log(
    "The .env file is not configured. Follow the instructions in the readme to configure the .env file. https://github.com/stripe-samples/subscription-use-cases"
  );
  console.log("");
  process.env.STRIPE_SECRET_KEY
    ? ""
    : console.log("Add STRIPE_SECRET_KEY to your .env file.");

  process.env.STRIPE_PUBLISHABLE_KEY
    ? ""
    : console.log("Add STRIPE_PUBLISHABLE_KEY to your .env file.");

  process.env.FOREX
    ? ""
    : console.log(
        "Add Forex priceID to your .env file. See repo readme for setup instructions."
      );

  process.env.STOCK
    ? ""
    : console.log(
        "Add Stock priceID to your .env file. See repo readme for setup instructions."
      );

  process.env.INDICES
    ? ""
    : console.log(
        "Add Indices priceID to your .env file. See repo readme for setup instructions."
      );

  process.env.CRYPTO
    ? ""
    : console.log(
        "Add Crypto priceID to your .env file. See repo readme for setup instructions."
      );

  process.env.STATIC_DIR
    ? ""
    : console.log(
        "Add STATIC_DIR to your .env file. Check .env.example in the root folder for an example"
      );

  process.exit();
}

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.use(express.static(process.env.STATIC_DIR));
// Use JSON parser for all non-webhook routes.
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next();
  } else {
    bodyParser.json()(req, res, next);
  }
});

app.get("/", (req, res) => {
  const path = resolve(process.env.HTML_DIR + "/index.html");
  res.sendFile(path);
});

app.get("/account", (req, res) => {
  const path = resolve(process.env.HTML_DIR + "/account.html");
  res.sendFile(path);
});

app.get("/prices", async (req, res) => {
  const id = req.query.customerId;
  if (id) {
    try {
      const customer = await stripe.customers.retrieve(id);

      const path = resolve(process.env.HTML_DIR + "/prices.html");
      res.sendFile(path);
    } catch (err) {
      res.redirect("/");
    }
  } else {
    res.redirect("/");
  }
});

app.get("/config", async (req, res) => {
  res.send({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  });
});

app.post("/create-customer", async (req, res) => {
  // Create a new customer object

  let customer = await stripe.customers.list({
    email: req.body.email,
  });

  if (customer.data.length === 0) {
    customer = await stripe.customers.create({
      email: req.body.email,
    });
  } else {
    customer = customer.data[0];
  }

  // save the customer.id as stripeCustomerId
  // in your database.

  res.send({ customer });
});

app.post("/create-subscription", async (req, res) => {
  // Set the default payment method on the customer
  try {
    await stripe.paymentMethods.attach(req.body.paymentMethodId, {
      customer: req.body.customerId,
    });
  } catch (error) {
    return res.status("402").send({ error: { message: error.message } });
  }

  let updateCustomerDefaultPaymentMethod = await stripe.customers.update(
    req.body.customerId,
    {
      invoice_settings: {
        default_payment_method: req.body.paymentMethodId,
      },
    }
  );

  // Create the subscription
  const subscription = await stripe.subscriptions.create({
    customer: req.body.customerId,
    items: [{ price: process.env[req.body.priceId] }],
    expand: ["latest_invoice.payment_intent", "pending_setup_intent"],
    coupon: req.body.coupon,
  });

  res.send(subscription);
});

app.post("/retry-invoice", async (req, res) => {
  // Set the default payment method on the customer

  try {
    await stripe.paymentMethods.attach(req.body.paymentMethodId, {
      customer: req.body.customerId,
    });
    await stripe.customers.update(req.body.customerId, {
      invoice_settings: {
        default_payment_method: req.body.paymentMethodId,
      },
    });
  } catch (error) {
    // in case card_decline error
    return res
      .status("402")
      .send({ result: { error: { message: error.message } } });
  }

  const invoice = await stripe.invoices.retrieve(req.body.invoiceId, {
    expand: ["payment_intent"],
  });
  res.send(invoice);
});

app.post("/retrieve-upcoming-invoice", async (req, res) => {
  const subscription = await stripe.subscriptions.retrieve(
    req.body.subscriptionId
  );

  const invoice = await stripe.invoices.retrieveUpcoming({
    subscription_prorate: true,
    customer: req.body.customerId,
    subscription: req.body.subscriptionId,
    subscription_items: [
      {
        id: subscription.items.data[0].id,
        clear_usage: true,
        deleted: true,
      },
      {
        price: process.env[req.body.newPriceId],
        deleted: false,
      },
    ],
  });
  res.send(invoice);
});

app.post("/cancel-subscription", async (req, res) => {
  // Delete the subscription
  const deletedSubscription = await stripe.subscriptions.del(
    req.body.subscriptionId
  );
  res.send(deletedSubscription);
});

app.post("/update-subscription", async (req, res) => {
  const subscription = await stripe.subscriptions.retrieve(
    req.body.subscriptionId
  );
  const updatedSubscription = await stripe.subscriptions.update(
    req.body.subscriptionId,
    {
      cancel_at_period_end: false,
      items: [
        {
          id: subscription.items.data[0].id,
          price: process.env[req.body.newPriceId],
        },
      ],
    }
  );

  res.send(updatedSubscription);
});

app.post("/retrieve-customer-payment-method", async (req, res) => {
  const paymentMethod = await stripe.paymentMethods.retrieve(
    req.body.paymentMethodId
  );

  res.send(paymentMethod);
});
// Webhook handler for asynchronous events.
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    // Retrieve the event by verifying the signature using the raw body and secret.
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log(err);
      console.log(`⚠️  Webhook signature verification failed.`);
      console.log(
        `⚠️  Check the env file and enter the correct webhook secret.`
      );
      return res.sendStatus(400);
    }
    // Extract the object from the event.
    const dataObject = event.data.object;

    // Handle the event
    // Review important events for Billing webhooks
    // https://stripe.com/docs/billing/webhooks
    // Remove comment to see the various objects sent for this sample
    switch (event.type) {
      case "invoice.paid":
        // Used to provision services after the trial has ended.
        // The status of the invoice will show up as paid. Store the status in your
        // database to reference when a user accesses your service to avoid hitting rate limits.
        break;
      case "invoice.payment_failed":
        // If the payment fails or the customer does not have a valid payment method,
        //  an invoice.payment_failed event is sent, the subscription becomes past_due.
        // Use this webhook to notify your user that their payment has
        // failed and to retrieve new card details.
        break;
      case "invoice.finalized":
        // If you want to manually send out invoices to your customers
        // or store them locally to reference to avoid hitting Stripe rate limits.
        break;
      case "customer.subscription.deleted":
        if (event.request != null) {
          // handle a subscription cancelled by your request
          // from above.
        } else {
          // handle subscription cancelled automatically based
          // upon your subscription settings.
        }
        break;
      case "customer.subscription.trial_will_end":
        // Send notification to your user that the trial will end
        break;
      default:
      // Unexpected event type
    }
    res.sendStatus(200);
  }
);

app.post("/customer", async function (req, res) {
  const r = {
    found: false,
    type: null,
    sub: false,
    Accounts: 0,
    result: null,
    email: "",
  };
  if (!req.body.email && !req.body.id) {
    res.json(r);
    return;
  }

  let email = req.body.email;
  let customers = req.body.id;
  if (!customers) {
    customers = await stripe.customers.list({
      email: email,
    });
    if (customers.data.length === 0) return res.json({ err: "invalid Email" });
    customers = customers.data[0].id;
  }
  if (!email) {
    const customer = await stripe.customers.retrieve(customers);
    if (!customer.email) return res.json({ err: "invalid Email" });
    email = customer.email;
  }

  r.email = email;
  const subscriptions = await stripe.subscriptions.list({
    customer: customers,
  });

  try {
    const au = await findUser(email);
    if (!au.Item) {
      await addUser(customers, email);
      r.Accounts = 0;
    } else {
      r.Accounts = au.Item.Accounts.length;
    }

    if (req.body.ip && req.body.server) {
      const ap = await addIP(email, {
        ANo: req.body.ip,
        server: req.body.server,
      });
      console.log(ap);
    }
  } catch (e) {
    console.log("DY_DB_CUS_ERROR => ", e);
  }

  const { data } = subscriptions;

  if (data.length > 0) {
    r.found = true;
    r.result = data.map((i) => {
      let sub = [];
      if (i.plan) {
        let type = null;
        if (i.plan.id == process.env.FOREX) {
          type = "FOREX";
          if (type === req.body.type) r.sub = true;
        } else if (i.plan.id == process.env.CRYPTO) {
          type = "CRYPTO";
          if (type === req.body.type) r.sub = true;
        } else if (i.plan.id == process.env.INDICES) {
          type = "INDICES";
          if (type === req.body.type) r.sub = true;
        } else if (i.plan.id == process.env.STOCK) {
          type = "STOCK";
          if (type === req.body.type) r.sub = true;
        }
        sub.push(type);
        r.type = type;
      }
      return {
        email: i.email,
        id: i.id,
        subs: sub,
      };
    });
  }

  res.json(r);
});

app.post("/check-coupon", async function (req, res) {
  const r = { res: null, err: null };
  try {
    r.res = await stripe.coupons.retrieve(req.body.coupon);
  } catch (e) {
    r.err = e;
  }
  res.json(r);
});

app.post("/check-ip", async function (req, res) {
  let r = { valid: false, accounts: {} };
  const { ip, email } = req.body;
  if (!ip || !email) return res.json(r);

  const r1 = await findIP(email);
  if (!r1.Item) return res.json(r);

  const { Accounts } = r1.Item;
  r.accounts = Accounts;

  Accounts.map((i) => {
    if (i.ANo === ip) r.valid = true;
  });
  res.json(r);
});

app.post("/get-ip", async function (req, res) {
  let r = {};
  const { email } = req.body;
  if (!email) return res.json(r);

  const r1 = await findUser(email);
  res.json(r1);
});

app.post("/remove-ip", async function (req, res) {
  let r = {};
  const { ind, email } = req.body;

  if (!email || ind === undefined) return res.json(r);
  const r1 = await removeIP(email, ind);
  res.json(r1);
});

app.post("/result", async function (req, res) {
  const { email, account, data } = req.body;

  console.log(email);
  console.log(account);
  console.log(data);

  if (!email || !account) return res.json(r);

  const r1 = await addResult(email, account, data);
  res.json({ r1, data });
});

app.post("/message", async function (req, res) {
  let r = "";
  if (process.env.VERSION > req.body.version) r = process.env.MESSAGE;
  res.json(r);
});

const port = process.env.PORT || 8080;

app.listen(port, () => console.log(`Node server listening on port ${port}!`));
