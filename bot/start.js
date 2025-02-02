const { Telegraf, Scenes, session } = require('telegraf');
const schedule = require('node-schedule');
const { Order, User, PendingPayment } = require('../models');
const { getCurrenciesWithPrice, getBtcFiatPrice } = require('../util');
const ordersActions = require('./ordersActions');
const { takebuy, takesell } = require('./commands');
const {
  settleHoldInvoice,
  cancelHoldInvoice,
  payToBuyer,
  createHoldInvoice,
  subscribeInvoice,
  getInfo,
} = require('../ln');
const {
  validateSellOrder,
  validateUser,
  validateBuyOrder,
  validateReleaseOrder,
  validateDisputeOrder,
  validateAdmin,
  validateFiatSentOrder,
  validateSeller,
  validateParams,
  validateObjectId,
  validateInvoice,
} = require('./validations');
const messages = require('./messages');
const { attemptPendingPayments, cancelOrders } = require('../jobs');
const addInvoiceWizard = require('./scenes');

const initialize = (botToken, options) => {
  const bot = new Telegraf(botToken, options);

  // We schedule pending payments job
  const pendingPaymentJob = schedule.scheduleJob(`*/${process.env.PENDING_PAYMENT_WINDOW} * * * *`, async () => {
    await attemptPendingPayments(bot);
  });
  const cancelOrderJob = schedule.scheduleJob(`*/2 * * * *`, async () => {
    await cancelOrders(bot);
  });

  const stage = new Scenes.Stage([addInvoiceWizard]);
  bot.use(session());

  bot.use(stage.middleware());

  bot.start(async (ctx) => {
    try {
      const tgUser = ctx.update.message.from;
      if (!tgUser.username) {
        await messages.nonHandleErrorMessage(ctx);
        return;
      }
      messages.startMessage(ctx);
      await validateUser(ctx, bot, true);
    } catch (error) {
      console.log(error);
    }
  });

  bot.command('sell', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;
      // Sellers with orders in status = FIAT_SENT, have to solve the order
      const isOnFiatSentStatus = await validateSeller(bot, user);

      if (!isOnFiatSentStatus) return;

      const sellOrderParams = await validateSellOrder(ctx, bot, user);

      if (!sellOrderParams) return;
      const { amount, fiatAmount, fiatCode, paymentMethod, showUsername } = sellOrderParams;
      const order = await ordersActions.createOrder(ctx, bot, user, {
        type: 'sell',
        amount,
        seller: user,
        fiatAmount,
        fiatCode,
        paymentMethod,
        status: 'PENDING',
        showUsername,
      });

      if (!!order) {
        await messages.publishSellOrderMessage(ctx, bot, order);
        await messages.pendingSellMessage(bot, user, order);
      }
    } catch (error) {
      console.log(error);
    }
  });

  bot.command('buy', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;

      const buyOrderParams = await validateBuyOrder(ctx, bot, user);
      if (!buyOrderParams) return;

      const { amount, fiatAmount, fiatCode, paymentMethod, showUsername } = buyOrderParams;
      //revisar por que esta creando invoice sin monto
      const order = await ordersActions.createOrder(ctx, bot, user, {
        type: 'buy',
        amount,
        buyer: user,
        fiatAmount,
        fiatCode,
        paymentMethod,
        status: 'PENDING',
        showUsername,
      });

      if (!!order) {
        await messages.publishBuyOrderMessage(ctx, bot, order);
        await messages.pendingBuyMessage(bot, user, order);
      }
    } catch (error) {
      console.log(error);
    }
  });

  bot.action('takesell', async (ctx) => {
    await takesell(ctx, bot);
  });

  bot.action('takebuy', async (ctx) => {
    await takebuy(ctx, bot);
  });

  bot.command('release', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);
      if (!user) return;

      const [orderId] = await validateParams(ctx, bot, user, 2, '<order_id>');

      if (!orderId) return;
      if (!(await validateObjectId(bot, user, orderId))) return;
      const order = await validateReleaseOrder(bot, user, orderId);

      if (!order) return;

      await settleHoldInvoice({ secret: order.secret });
    } catch (error) {
      console.log(error);
    }
  });

  bot.command('dispute', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;

      const [orderId] = await validateParams(ctx, bot, user, 2, '<order_id>');

      if (!orderId) return;
      if (!(await validateObjectId(bot, user, orderId))) return;
      const order = await validateDisputeOrder(bot, user, orderId);

      if (!order) return;

      let buyer = await User.findOne({ _id: order.buyer_id });
      let seller = await User.findOne({ _id: order.seller_id });
      let initiator = 'seller';
      if (user._id == order.buyer_id) initiator = 'buyer';

      order[`${initiator}_dispute`] = true;
      order.status = 'DISPUTE';
      await order.save();
      // We increment the number of disputes on both users
      // If a user disputes is equal to MAX_DISPUTES, we ban the user
      const buyerDisputes = buyer.disputes + 1;
      const sellerDisputes = seller.disputes + 1;
      buyer.disputes = buyerDisputes;
      seller.disputes = sellerDisputes;
      if (buyerDisputes >= process.env.MAX_DISPUTES) {
        buyer.banned = true;
      }
      if (sellerDisputes >= process.env.MAX_DISPUTES) {
        seller.banned = true;
      }
      await buyer.save();
      await seller.save();
      await messages.beginDisputeMessage(bot, buyer, seller, order, initiator);
    } catch (error) {
      console.log(error);
    }
  });

  // We allow users cancel pending orders,
  // pending orders are the ones that are not taken by another user
  bot.command('cancel', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);
      if (!user) return;

      const [orderId] = await validateParams(ctx, bot, user, 2, '<order_id>');

      if (!orderId) return;
      if (!(await validateObjectId(bot, user, orderId))) return;
      const order = await ordersActions.getOrder(bot, user, orderId);

      if (!order) return;

      if (order.status !== 'PENDING' && order.status !== 'WAITING_PAYMENT') {
        await messages.badStatusOnCancelOrderMessage(bot, user);
        return;
      }

      // If we already have a holdInvoice we cancel it and return the money
      if (!!order.hash) {
        await cancelHoldInvoice({ hash: order.hash });
      }

      order.status = 'CANCELED';
      order.canceled_by = user._id;
      await order.save();
      // we sent a private message to the user
      await messages.successCancelOrderMessage(bot, user, order);
      // We delete the messages related to that order from the channel
      await bot.telegram.deleteMessage(process.env.CHANNEL, order.tg_channel_message1);
      await bot.telegram.deleteMessage(process.env.CHANNEL, order.tg_channel_message2);
    } catch (error) {
      console.log(error);
    }
  });

  bot.command('cancelorder', async (ctx) => {
    try {
      const user = await validateAdmin(ctx, bot);
      if (!user) return;

      const [orderId] = await validateParams(ctx, bot, user, 2, '<order_id>');

      if (!orderId) return;
      if (!(await validateObjectId(bot, user, orderId))) return;
      const order = await Order.findOne({ _id: orderId });

      if (!order) return;

      if (!!order.hash) {
        await cancelHoldInvoice({ hash: order.hash });
      }

      order.status = 'CANCELED_BY_ADMIN';
      order.canceled_by = user._id;
      const buyer = await User.findOne({ _id: order.buyer_id });
      const seller = await User.findOne({ _id: order.seller_id });
      await order.save();
      // we sent a private message to the admin
      await messages.successCancelOrderMessage(bot, user, order);
      // we sent a private message to the seller
      await messages.successCancelOrderByAdminMessage(bot, seller, order);
      // we sent a private message to the buyer
      await messages.successCancelOrderByAdminMessage(bot, buyer, order);
    } catch (error) {
      console.log(error);
    }
  });


  bot.command('settleorder', async (ctx) => {
    try {
      const user = await validateAdmin(ctx, bot);
      if (!user) return;

      const [orderId] = await validateParams(ctx, bot, user, 2, '<order_id>');

      if (!orderId) return;
      if (!(await validateObjectId(bot, user, orderId))) return;

      const order = await Order.findOne({_id: orderId});
      if (!order) return;

      if (!!order.secret) {
        await settleHoldInvoice({ secret: order.secret });
      }

      order.status = 'COMPLETED_BY_ADMIN';
      const buyer = await User.findOne({ _id: order.buyer_id });
      const seller = await User.findOne({ _id: order.seller_id });
      await order.save();
      // we sent a private message to the admin
      await messages.successCompleteOrderMessage(bot, user, order);
      // we sent a private message to the seller
      await messages.successCompleteOrderByAdminMessage(bot, seller, order);
      // we sent a private message to the buyer
      await messages.successCompleteOrderByAdminMessage(bot, buyer, order);
    } catch (error) {
      console.log(error);
    }
  });


  bot.command('checkorder', async (ctx) => {
    try {
      const user = await validateAdmin(ctx, bot);
      if (!user) return;

      const [orderId] = await validateParams(ctx, bot, user, 2, '<order_id>');

      if (!orderId) return;
      if (!(await validateObjectId(bot, user, orderId))) return;
      const order = await Order.findOne({_id: orderId});

      if (!order) return;

      const creator = await User.findOne({ _id: order.creator_id });
      const buyer = await User.findOne({ _id: order.buyer_id });
      const seller = await User.findOne({ _id: order.seller_id });
      const buyerUsername = !!buyer ? buyer.username : '';
      const sellerUsername = !!seller ? seller.username : '';

      await messages.checkOrderMessage(ctx, order, creator.username, buyerUsername, sellerUsername);

    } catch (error) {
      console.log(error);
    }
  });

  bot.command('help', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);
      if (!user) return;

      await messages.helpMessage(ctx);
    } catch (error) {
      console.log(error);
    }
  });

  // Only buyers can use this command
  bot.command('fiatsent', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;
      const [orderId] = await validateParams(ctx, bot, user, 2, '<order_id>');

      if (!orderId) return;
      if (!(await validateObjectId(bot, user, orderId))) return;
      const order = await validateFiatSentOrder(bot, user, orderId);
      if (!order) return;

      if (order.status == 'PAID_HOLD_INVOICE') {
        await messages.sellerPaidHoldMessage(bot, user);
        return;
      }

      order.status = 'FIAT_SENT';
      const seller = await User.findOne({ _id: order.seller_id });
      await order.save();
      // We sent messages to both parties
      await messages.fiatSentMessages(bot, user, seller, order);

    } catch (error) {
      console.log(error);
    }
  });

  bot.command('cooperativecancel', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;

      const [orderId] = await validateParams(ctx, bot, user, 2, '<order_id>');

      if (!orderId) return;
      if (!(await validateObjectId(bot, user, orderId))) return;
      const order = await ordersActions.getOrder(bot, user, orderId);

      if (!order) return;

      if (order.status != 'ACTIVE') {
        await messages.onlyActiveCooperativeCancelMessage(bot, user);
        return;
      }
      let initiatorUser, counterPartyUser, initiator, counterParty;

      if (user._id == order.buyer_id) {
        initiatorUser = user;
        counterPartyUser = await User.findOne({ _id: order.seller_id });
        initiator = 'buyer';
        counterParty = 'seller';
      } else {
        counterPartyUser = await User.findOne({ _id: order.buyer_id });
        initiatorUser = user;
        initiator = 'seller';
        counterParty = 'buyer';
      }

      if (order[`${initiator}_cooperativecancel`]) {
        await messages.shouldWaitCooperativeCancelMessage(bot, initiatorUser);
        return;
      }

      order[`${initiator}_cooperativecancel`] = true;

      // If the counter party already requested a cooperative cancel order
      if (order[`${counterParty}_cooperativecancel`]) {
        // If we already have a holdInvoice we cancel it and return the money
        if (!!order.hash) {
          await cancelHoldInvoice({ hash: order.hash });
        }

        order.status = 'CANCELED';
        // We sent a private message to the users
        await messages.successCancelOrderMessage(bot, initiatorUser, order);
        await messages.okCooperativeCancelMessage(bot, counterPartyUser, order);
      } else {
        await messages.initCooperativeCancelMessage(bot, initiatorUser, order);
        await messages.counterPartyWantsCooperativeCancelMessage(bot, counterPartyUser, order);
      }
      await order.save();

    } catch (error) {
      console.log(error);
    }
  });

  bot.command('ban', async (ctx) => {
    try {
      const adminUser = await validateAdmin(ctx, bot);

      if (!adminUser) return;

      const [ username ] = await validateParams(ctx, bot, adminUser, 2, '<username>');

      if (!username) return;
      
      const user = await User.findOne({ username });
      if (!user) {
        await messages.notFoundUserMessage(bot, adminUser);
        return;
      }

      if (!(await validateObjectId(bot, user, params[0]))) return;
      user.banned = true;
      await user.save();
      await messages.userBannedMessage(bot, adminUser);
    } catch (error) {
      console.log(error);
    }
  });

  // Only buyers can use this command
  bot.command('setinvoice', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;
      const [orderId, lnInvoice] = await validateParams(ctx, bot, user, 3, '<order_id> <lightning_invoice>');

      if (!orderId) return;
      const invoice = await validateInvoice(bot, user, lnInvoice);
      if (!invoice) return;
      if (!(await validateObjectId(bot, user, orderId))) return;
      const order = await Order.findOne({
        _id: orderId,
        buyer_id: user._id,
      });
      if (!order) {
        await messages.notActiveOrderMessage(bot, user);
        return;
      };
      if (order.status == 'SUCCESS') {
        await messages.successCompleteOrderMessage(bot, user, order);
        return;
      }
      if (invoice.tokens && invoice.tokens != order.amount) {
        await messages.incorrectAmountInvoiceMessage(bot, user);
        return;
      }
      order.buyer_invoice = lnInvoice;
      // When a seller release funds but the buyer didn't get the invoice paid
      if (order.status == 'PAID_HOLD_INVOICE') {
        const isPending = await PendingPayment.findOne({
          order_id: order._id,
          attempts: { $lt: 3 },
        });

        if (!!isPending) {
          await messages.invoiceAlreadyUpdatedMessage(bot, user);
          return;
        }

        if (!order.paid_hold_buyer_invoice_updated) {
          order.paid_hold_buyer_invoice_updated = true;
          const pp = new PendingPayment({
            amount: order.amount,
            payment_request: lnInvoice,
            user_id: user._id,
            description: order.description,
            hash: order.hash,
            order_id: order._id,
          });
          await pp.save();
          await messages.invoiceUpdatedPaymentWillBeSendMessage(bot, user);
        } else {
          await messages.invoiceAlreadyUpdatedMessage(bot, user);
        }
      } else {
        await messages.invoiceUpdatedMessage(bot, user);
      }

      await order.save();
    } catch (error) {
      console.log(error);
      const user = await validateUser(ctx, bot, false);
      await messages.genericErrorMessage(bot, user);
    }
  });

  bot.command('listorders', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;

      const orders = await ordersActions.getOrders(bot, user);

      if (!orders) return;

      await messages.listOrdersResponse(bot, user, orders);

    } catch (error) {
      console.log(error);
    }
  });

  bot.action('addInvoiceBtn', async (ctx) => {
    try {
      ctx.deleteMessage();
      const orderId = ctx.update.callback_query.message.text;
      if (!orderId) return;
      const order = await Order.findOne({
        _id: orderId,
        status: { $ne: 'EXPIRED' },
      });
      if (!order) return;
      let amount = order.amount;
      if (amount == 0) {
          amount = await getBtcFiatPrice(order.fiat_code, order.fiat_amount);
          order.fee = amount * parseFloat(process.env.FEE);
          order.amount = amount;
      }
      // If the price API fails we can't continue with the process
      if (order.amount == 0) {
        await messages.priceApiFailedMessage(bot, user);
        return;
      }
      await order.save();
      let buyer = await User.findOne({ _id: order.buyer_id });
      let seller = await User.findOne({ _id: order.seller_id });
      ctx.scene.enter('ADD_INVOICE_WIZARD_SCENE_ID', { order, seller, buyer, bot });
    } catch (error) {
      console.log(error);
    }
  });

  bot.action('cancelAddInvoiceBtn', async (ctx) => {
    try {
      ctx.deleteMessage();
      const orderId = ctx.update.callback_query.message.text;
      if (!orderId) return;
      const order = await Order.findOne({ _id: orderId });
      if (!order) return;
      order.buyer_id = null;
      order.taken_at = null;
      order.status = 'PENDING';
      order.save();
      await messages.publishSellOrderMessage(ctx, bot, order);
    } catch (error) {
      console.log(error);
    }
  });

  bot.action('continueTakeBuyBtn', async (ctx) => {
    try {
      ctx.deleteMessage();
      const orderId = ctx.update.callback_query.message.text;
      if (!orderId) return;
      const order = await Order.findOne({ _id: orderId });
      if (!order) return;
      const user = await User.findOne({ _id: order.seller_id });
      // We create the hold invoice and show it to the seller
      const description = `Venta por @${ctx.botInfo.username} #${order._id}`;
      let amount;
      if (order.amount == 0) {
        amount = await getBtcFiatPrice(order.fiat_code, order.fiat_amount);
        order.fee = amount * parseFloat(process.env.FEE);
        order.amount = amount;
      }
      amount = Math.floor(order.amount + order.fee);
      const { request, hash, secret } = await createHoldInvoice({
        description,
        amount,
      });
      order.hash = hash;
      order.secret = secret;
      await order.save();

      // We monitor the invoice to know when the seller makes the payment
      await subscribeInvoice(bot, hash);
      await messages.showHoldInvoiceMessage(bot, user, request);
    } catch (error) {
      console.log(error);
    }
  });

  bot.action('cancelTakeBuyBtn', async (ctx) => {
    try {
      ctx.deleteMessage();
      const orderId = ctx.update.callback_query.message.text;
      if (!orderId) return;
      const order = await Order.findOne({ _id: orderId });
      if (!order) return;
      order.seller_id = null;
      order.taken_at = null;
      order.status = 'PENDING';
      order.save();
      await messages.publishBuyOrderMessage(ctx, bot, order);
    } catch (error) {
      console.log(error);
    }
  });

  bot.command('paytobuyer', async (ctx) => {
    try {
      const adminUser = await validateAdmin(ctx, bot);
      if (!adminUser) return;
      const [ orderId ] = await validateParams(ctx, bot, adminUser, 2, '<order_id>');
      if (!orderId) return;
      if (!(await validateObjectId(bot, adminUser, orderId))) return;
      const order = await Order.findOne({
        _id: orderId,
      });
      if (!order) {
        await messages.notActiveOrderMessage(bot, adminUser);
        return;
      };

      // We make sure the buyers invoice is not being paid
      const isPending = await PendingPayment.findOne({
        order_id: order._id,
        attempts: { $lt: 3 },
      });

      if (!!isPending) {
        return;
      }
      await payToBuyer(bot, order);
    } catch (error) {
      console.log(error);
    }
  });

  bot.command('listcurrencies', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;

      const currencies = getCurrenciesWithPrice();

      await messages.listCurrenciesResponse(bot, user, currencies);
    } catch (error) {
      console.log(error);
    }
  });

  bot.command('info', async (ctx) => {
    try {
      const user = await validateUser(ctx, bot, false);

      if (!user) return;

      const info = await getInfo();

      await messages.showInfoMessage(bot, user, info);
    } catch (error) {
      console.log(error);
    }
  });

  return bot;
};

const start = (botToken) => {
  const bot = initialize(botToken);

  bot.launch();

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
};

module.exports = { initialize, start };
