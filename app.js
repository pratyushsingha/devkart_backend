import express from 'express';
import requestIp from 'request-ip';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN === '*'
        ? '*'
        : process.env.CORS_ORIGIN?.split(','),
    credentials: true
  })
);

app.use(requestIp.mw());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    return req.clientIp;
  },
  handler: (_, __, ___, options) => {
    throw new ApiError(
      options.statusCode || 500,
      `There are too many requests. You are only allowed ${
        options.max
      } requests per ${options.windowMs / 60000} minutes`
    );
  }
});
app.use(limiter);
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));
app.use(express.static('public'));
app.use(cookieParser());

import userRouter from './src/routes/user.routes.js';
import productRouter from './src/routes/product.routes.js';
import categoryRouter from './src/routes/category.routes.js';

app.use('/api/v1/users', userRouter);
app.use('/api/v1/products', productRouter);
app.use('/api/v1/categories', categoryRouter);

export { app };
