const express = require("express");
const app = express();
const bodyParser = require("body-parser");
require("dotenv").config({ path: "./.env" });
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const user = require("../Database/user");

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

  const newUser = await user.findById(req.body.userId);

  res.send({ subscription, newUser });
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

app.post("/add-payment-method", async (req, res) => {
  // Set the default payment method on the customer
  const { paymentMethodId, customerId } = req.body;
  if (!paymentMethodId || !customerId) {
    res.send("Invalid input");
    return;
  }
  let r = { upm: null, udpm: null };
  try {
    upm = await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });
  } catch (error) {
    return res.status("402").send({ error: { message: error.message } });
  }

  udpm = await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });
  res.json(r);
});

app.post("/retrieve-customer-payment-method", async (req, res) => {
  const paymentMethod = await stripe.paymentMethods.retrieve(
    req.body.paymentMethodId
  );

  res.send(paymentMethod);
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

module.exports = app;

// app.post("/retry-invoice", async (req, res) => {
//   // Set the default payment method on the customer

//   try {
//     await stripe.paymentMethods.attach(req.body.paymentMethodId, {
//       customer: req.body.customerId,
//     });
//     await stripe.customers.update(req.body.customerId, {
//       invoice_settings: {
//         default_payment_method: req.body.paymentMethodId,
//       },
//     });
//   } catch (error) {
//     // in case card_decline error
//     return res
//       .status("402")
//       .send({ result: { error: { message: error.message } } });
//   }

//   const invoice = await stripe.invoices.retrieve(req.body.invoiceId, {
//     expand: ["payment_intent"],
//   });
//   res.send(invoice);
// });

// app.post("/retrieve-upcoming-invoice", async (req, res) => {
//   const subscription = await stripe.subscriptions.retrieve(
//     req.body.subscriptionId
//   );

//   const invoice = await stripe.invoices.retrieveUpcoming({
//     subscription_prorate: true,
//     customer: req.body.customerId,
//     subscription: req.body.subscriptionId,
//     subscription_items: [
//       {
//         id: subscription.items.data[0].id,
//         clear_usage: true,
//         deleted: true,
//       },
//       {
//         price: process.env[req.body.newPriceId],
//         deleted: false,
//       },
//     ],
//   });
//   res.send(invoice);
// });

// app.post("/create-customer", async (req, res) => {
//   // Create a new customer object

//   let customer = await stripe.customers.list({
//     email: req.body.email,
//   });

//   if (customer.data.length === 0) {
//     customer = await stripe.customers.create({
//       email: req.body.email,
//     });
//   } else {
//     customer = customer.data[0];
//   }

//   // save the customer.id as stripeCustomerId
//   // in your database.

//   res.send({ customer });
// });