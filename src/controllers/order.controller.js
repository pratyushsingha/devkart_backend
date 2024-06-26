import { Address } from '../../models/address.model.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import { getCart } from './cart.controller.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { Order } from '../../models/order.model.js';
import { Cart } from '../../models/cart.model.js';
import mongoose from 'mongoose';
import { getMongoosePaginationOptions } from '../utils/helper.js';
import { Product } from '../../models/product.model.js';

const updateStock = async (orderPaymentId, req) => {
  const order = await Order.findOneAndUpdate(
    { paymentId: orderPaymentId },
    {
      $set: {
        isPAymentDone: true
      }
    },
    { new: true }
  );

  if (!order) {
    throw new ApiError(409, 'order not found');
  }
  const cart = await Cart.findOne({
    owner: req.user._id
  });

  const userCart = await getCart(req.user._id);

  let bulkStockUpdates = userCart.items.map((item) => {
    return {
      updateOne: {
        filter: { _id: item.product?._id },
        update: { $inc: { stock: -item.quantity } }
      }
    };
  });

  await Product.bulkWrite(bulkStockUpdates, {
    skipValidation: true
  });

  cart.items = [];
  cart.coupon = null;

  await cart.save({ validateBeforeSave: false });
  return order;
};

const instance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const checkout = asyncHandler(async (req, res) => {
  const { addressId } = req.body;

  const address = await Address.findOne({
    owner: req.user._id,
    _id: addressId
  });

  if (!address) {
    throw new ApiError(403, 'address not found');
  }

  const userCart = await Cart.findOne({
    owner: req.user._id
  });
  // console.log(userCart);
  if (!userCart || !userCart.items?.length) {
    throw new ApiError(400, 'cart is empty');
  }
  const orderItems = userCart.items;
  // console.log(userCart.items);
  const cart = await getCart(req.user._id);

  const options = {
    amount: Number(cart.discountCartValue * 100),
    currency: 'INR',
    receipt: nanoid(10)
  };

  instance.orders.create(options, async function (err, razorpayOrder) {
    if (!razorpayOrder || (err && err.error)) {
      return res
        .status(err.statusCode)
        .json(
          new ApiResponse(
            err.statusCode,
            null,
            err.error.reason ||
              'Something went wrong while initialising the razorpay order.'
          )
        );
    }

    // console.log({
    //   address: addressId,
    //   customer: req.user._id,
    //   items: orderItems,
    //   orderPrice: cart.cartTotal ?? 0,
    //   disCountedOrderPrice: cart.discountCartValue ?? 0,
    //   paymentId: razorpayOrder.id,
    //   coupon: cart.coupon?._id,
    //   owner: req.user._id
    // });

    const unpaidOrder = await Order.create({
      address: addressId,
      customer: req.user._id,
      items: orderItems,
      orderPrice: cart.cartTotal ?? 0,
      disCountedOrderPrice: cart.discountCartValue ?? 0,
      paymentId: razorpayOrder.id,
      coupon: cart.coupon?._id,
      owner: req.user._id
    });
    if (unpaidOrder) {
      return res
        .status(200)
        .json(new ApiResponse(200, razorpayOrder, 'Razorpay order generated'));
    } else {
      return res
        .status(500)
        .json(
          new ApiResponse(
            500,
            null,
            'Something went wrong while initialising the razorpay order.'
          )
        );
    }
  });
});

const orderVerification = async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;
  console.log(req.body);
  const body = razorpay_order_id + '|' + razorpay_payment_id;

  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest('hex');
  console.log(signature, razorpay_signature);

  if (signature === razorpay_signature) {
    await updateStock(razorpay_order_id, req);
    return res
      .status(201)
      .redirect(
        `${process.env.FRONTEND_URL}/paymentsuccess?ref=${razorpay_payment_id}`
      );
  } else {
    throw new ApiError('something went wrong');
  }

  // console.log('ok');
};

const getOrderById = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const order = await Order.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(orderId)
      }
    },
    {
      $lookup: {
        from: 'addresses',
        localField: 'address',
        foreignField: '_id',
        as: 'address'
      }
    },
    {
      $lookup: {
        from: 'coupons',
        localField: 'coupon',
        foreignField: '_id',
        as: 'coupon',
        pipeline: [
          {
            $project: {
              _id: 1,
              couponCode: 1,
              name: 1
            }
          }
        ]
      }
    },
    {
      $lookup: {
        from: 'users',
        localField: 'owner',
        foreignField: '_id',
        as: 'customer',
        pipeline: [
          {
            $project: {
              _id: 1,
              email: 1,
              username: 1
            }
          }
        ]
      }
    },
    {
      $unwind: '$items'
    },
    {
      $lookup: {
        from: 'products',
        localField: 'items.product',
        foreignField: '_id',
        as: 'items.product'
      }
    },
    {
      $unwind: '$items.product'
    },

    {
      $group: {
        _id: '$_id',
        orderPrice: { $first: '$orderPrice' },
        disCountedOrderPrice: {
          $first: '$disCountedOrderPrice'
        },
        customer: { $first: '$customer' },
        coupon: { $first: '$coupon' },
        address: { $first: '$address' },
        items: { $push: '$items' },
        status: { $first: '$status' },
        paymentId: { $first: '$paymentId' }
      }
    },
    {
      $project: {
        _id: 1,
        orderPrice: 1,
        disCountedOrderPrice: 1,
        customer: { $first: '$customer' },
        coupon: {
          $ifNull: [{ $first: '$coupon' }, null]
        },
        address: { $first: '$address' },
        items: 1,
        status: 1,
        paymentId: 1
      }
    }
  ]);

  if (!order) {
    throw new ApiError(
      500,
      'something went wrong while fetching the order Details'
    );
  }

  return res
    .status(201)
    .json(new ApiResponse(201, order, 'order details fetched successfully'));
});

const orderListAdmin = asyncHandler(async (req, res) => {
  let matchStage = {};
  const { page, limit, status } = req.query;

  if (status) {
    matchStage = { status: status };
  }

  const orderAggregate = Order.aggregate([
    {
      $match: matchStage
    },
    {
      $unwind: {
        path: '$items'
      }
    },
    {
      $lookup: {
        from: 'products',
        localField: 'items.product',
        foreignField: '_id',
        as: 'items.product',
        pipeline: [
          {
            $project: {
              owner: 1
            }
          }
        ]
      }
    },
    {
      $unwind: {
        path: '$items.product'
      }
    },
    {
      $match: {
        'items.product.owner': new mongoose.Types.ObjectId(req.user._id)
      }
    },
    {
      $lookup: {
        from: 'users',
        localField: 'owner',
        foreignField: '_id',
        as: 'customer',
        pipeline: [
          {
            $project: {
              _id: 1,
              username: 1
            }
          }
        ]
      }
    },
    {
      $project: {
        _id: 1,
        customer: { $first: '$customer' },
        disCountedOrderPrice: 1,
        orderPrice: 1,
        status: 1
      }
    }
  ]);

  const orderList = await Order.aggregatePaginate(
    orderAggregate,
    getMongoosePaginationOptions({
      page,
      limit,
      customLabels: {
        totalDocs: 'OrderList',
        docs: 'orders'
      }
    })
  );

  if (!orderList) {
    throw new ApiError(
      500,
      'Something went wrong while fetching the order list'
    );
  }

  return res
    .status(200)
    .json(new ApiResponse(200, orderList, 'Order list fetched successfully'));
});

const myOrders = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  let matchStage = {};
  if (status) {
    matchStage = {
      status: status
    };
  }
  const myOrderAggregate = Order.aggregate([
    {
      $match: matchStage
    },
    {
      $match: {
        owner: new mongoose.Types.ObjectId(req.user._id)
      }
    },
    {
      $lookup: {
        from: 'addresses',
        localField: 'address',
        foreignField: '_id',
        as: 'address'
      }
    },
    {
      $lookup: {
        from: 'coupons',
        localField: 'coupon',
        foreignField: '_id',
        as: 'coupon',
        pipeline: [
          {
            $project: {
              _id: 1,
              couponCode: 1,
              name: 1
            }
          }
        ]
      }
    },
    {
      $lookup: {
        from: 'users',
        localField: 'owner',
        foreignField: '_id',
        as: 'customer',
        pipeline: [
          {
            $project: {
              _id: 1,
              email: 1,
              username: 1
            }
          }
        ]
      }
    },
    {
      $project: {
        items: 1,
        coupon: { $first: '$coupon' },
        createdAt: 1,
        paymentId: 1,
        status: 1,
        updatedAt: 1,
        orderPrice: 1,
        disCountedOrderPrice: 1,
        isPAymentDone: 1,
        address: { $first: '$address' },
        customer: { $first: '$customer' },
        totalOrderItems: { $size: '$items' }
      }
    }
  ]);
  const order = await Order.aggregatePaginate(
    myOrderAggregate,
    getMongoosePaginationOptions({
      page,
      limit,
      customLabels: {
        totalDocs: 'AllOrders',
        docs: 'orders'
      }
    })
  );
  if (order.length === 0) {
    return res
      .status(201)
      .json(
        new ApiResponse(200, { orders: [] }, 'orders fetched successfully')
      );
  } else {
    return res
      .status(201)
      .json(new ApiResponse(201, order, 'orders fetched successfully'));
  }
});

const updateOrderStatus = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;

  const updateOrder = await Order.findByIdAndUpdate(
    orderId,
    {
      $set: {
        status
      }
    },
    { new: true }
  );

  if (!updateOrder) {
    throw new ApiError(500, 'something went wrong while updating order status');
  }

  return res
    .status(201)
    .json(
      new ApiResponse(
        200,
        { status: 'FULFILLED' },
        'order status changes successfully'
      )
    );
});

export {
  checkout,
  orderVerification,
  getOrderById,
  orderListAdmin,
  myOrders,
  updateOrderStatus
};
