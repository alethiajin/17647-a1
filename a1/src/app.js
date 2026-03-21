const express = require('express');
const axios = require('axios');
const pool = require('./db');

const app = express();
app.use(express.json());

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
]);

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPrice(price) {
  if (typeof price !== 'number' || Number.isNaN(price)) {
    return false;
  }
  return /^\d+(\.\d{1,2})?$/.test(String(price));
}

function normalizeAddress2(address2) {
  return address2 === undefined ? null : address2;
}

function formatCustomer(row) {
  return {
    id: Number(row.id),
    userId: row.userId,
    name: row.name,
    phone: row.phone,
    address: row.address,
    address2: row.address2,
    city: row.city,
    state: row.state,
    zipcode: row.zipcode
  };
}

function formatBook(row) {
  return {
    ISBN: row.ISBN,
    title: row.title,
    Author: row.Author,
    description: row.description,
    genre: row.genre,
    price: Number(row.price),
    quantity: Number(row.quantity),
    summary: row.summary
  };
}

async function generateSummary(book) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return `Summary for "${book.title}" by ${book.Author}. ${book.description}`;
  }

  try {
    const prompt = `Write a 500-word clear and professional book summary about the book below:

    Title: ${book.title}
    Author: ${book.Author}
    Description: ${book.description}
    Genre: ${book.genre}

    Keep in mind 500 words.
    Return only the summary text.`;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-latest',
        max_tokens: 700,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json'
        },
        timeout: 20000
      }
    );

    return response.data?.content?.[0]?.text ?? `Summary for "${book.title}" by ${book.Author}. ${book.description}`;
  } catch (err) {
    console.error('LLM summary error:', err.response?.data || err.message);
    return `Summary for "${book.title}" by ${book.Author}. ${book.description}`;
  }
}

async function updateBookSummaryAsync(book) {
  try {
    const summary = await generateSummary(book);

    await pool.execute(
      'UPDATE Books SET summary = ? WHERE ISBN = ?',
      [summary, book.ISBN]
    );
  } catch (err) {
    console.error('Async summary update error:', err);
  }
}

// GET /status
app.get('/status', (req, res) => {
  return res.type('text/plain').status(200).send('OK');
});

// POST /customers
app.post('/customers', async (req, res) => {
  try {
    const { userId, name, phone, address, address2, city, state, zipcode } = req.body;

    if (
      userId === undefined ||
      name === undefined ||
      phone === undefined ||
      address === undefined ||
      city === undefined ||
      state === undefined ||
      zipcode === undefined
    ) {
      return res.status(400).end();
    }

    if (!isValidEmail(userId) || !US_STATES.has(state)) {
      return res.status(400).end();
    }

    const [existing] = await pool.execute(
      'SELECT id FROM Customers WHERE userId = ?',
      [userId]
    );

    if (existing.length > 0) {
      return res.status(422).json({
        message: 'This user ID already exists in the system.'
      });
    }

    const storedAddress2 = normalizeAddress2(address2);

    const [result] = await pool.execute(
      `INSERT INTO Customers (userId, name, phone, address, address2, city, state, zipcode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, name, phone, address, storedAddress2, city, state, zipcode]
    );

    const customer = {
      id: Number(result.insertId),
      userId,
      name,
      phone,
      address,
      address2: storedAddress2,
      city,
      state,
      zipcode
    };

    return res
      .status(201)
      .location(`/customers/${result.insertId}`)
      .json(customer);
  } catch (err) {
    console.error('POST /customers error:', err);
    return res.status(400).end();
  }
});

// GET /customers/{id}
app.get('/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
      return res.status(400).end();
    }

    const [rows] = await pool.execute(
      `SELECT id, userId, name, phone, address, address2, city, state, zipcode
       FROM Customers
       WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).end();
    }

    return res.status(200).json(formatCustomer(rows[0]));
  } catch (err) {
    console.error('GET /customers/:id error:', err);
    return res.status(400).end();
  }
});

// GET /customers?userId=...
app.get('/customers', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || !isValidEmail(userId)) {
      return res.status(400).end();
    }

    const [rows] = await pool.execute(
      `SELECT id, userId, name, phone, address, address2, city, state, zipcode
       FROM Customers
       WHERE userId = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).end();
    }

    return res.status(200).json(formatCustomer(rows[0]));
  } catch (err) {
    console.error('GET /customers error:', err);
    return res.status(400).end();
  }
});

// POST /books
app.post('/books', async (req, res) => {
  try {
    const { ISBN, title, Author, description, genre, price, quantity } = req.body;

    if (
      ISBN === undefined ||
      title === undefined ||
      Author === undefined ||
      description === undefined ||
      genre === undefined ||
      price === undefined ||
      quantity === undefined
    ) {
      return res.status(400).end();
    }

    if (!isValidPrice(price)) {
      return res.status(400).end();
    }

    const [existing] = await pool.execute(
      'SELECT ISBN FROM Books WHERE ISBN = ?',
      [ISBN]
    );

    if (existing.length > 0) {
      return res.status(422).json({
        message: 'This ISBN already exists in the system.'
      });
    }

    await pool.execute(
      `INSERT INTO Books (ISBN, title, Author, description, genre, price, quantity, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ISBN, title, Author, description, genre, price, quantity, null]
    );

    const book = {
      ISBN,
      title,
      Author,
      description,
      genre,
      price: Number(price),
      quantity: Number(quantity)
    };

    updateBookSummaryAsync({
      ISBN,
      title,
      Author,
      description,
      genre
    });

    return res
      .status(201)
      .location(`/books/${ISBN}`)
      .json(book);
  } catch (err) {
    console.error('POST /books error:', err);
    return res.status(400).end();
  }
});

// PUT /books/{ISBN}
app.put('/books/:ISBN', async (req, res) => {
  try {
    const pathISBN = req.params.ISBN;
    const { ISBN, title, Author, description, genre, price, quantity } = req.body;

    if (
      ISBN === undefined ||
      title === undefined ||
      Author === undefined ||
      description === undefined ||
      genre === undefined ||
      price === undefined ||
      quantity === undefined
    ) {
      return res.status(400).end();
    }

    if (!isValidPrice(price)) {
      return res.status(400).end();
    }

    const [existing] = await pool.execute(
      'SELECT ISBN FROM Books WHERE ISBN = ?',
      [pathISBN]
    );

    if (existing.length === 0) {
      return res.status(404).end();
    }

    await pool.execute(
      `UPDATE Books
       SET ISBN = ?, title = ?, Author = ?, description = ?, genre = ?, price = ?, quantity = ?
       WHERE ISBN = ?`,
      [ISBN, title, Author, description, genre, price, quantity, pathISBN]
    );

    return res.status(200).json({
      ISBN,
      title,
      Author,
      description,
      genre,
      price: Number(price),
      quantity: Number(quantity)
    });
  } catch (err) {
    console.error('PUT /books/:ISBN error:', err);
    return res.status(400).end();
  }
});

async function getBookByISBN(res, ISBN) {
  try {
    const [rows] = await pool.execute(
      `SELECT ISBN, title, Author, description, genre, price, quantity, summary
       FROM Books
       WHERE ISBN = ?`,
      [ISBN]
    );

    if (rows.length === 0) {
      return res.status(404).end();
    }

    return res.status(200).json(formatBook(rows[0]));
  } catch (err) {
    console.error('GET book error:', err);
    return res.status(400).end();
  }
}

// GET /books/isbn/{ISBN}
app.get('/books/isbn/:ISBN', async (req, res) => {
  return getBookByISBN(res, req.params.ISBN);
});

// GET /books/{ISBN}
app.get('/books/:ISBN', async (req, res) => {
  return getBookByISBN(res, req.params.ISBN);
});

module.exports = app;