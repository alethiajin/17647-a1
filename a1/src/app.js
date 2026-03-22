const express = require('express');
const axios = require('axios');
const pool = require('./db');

const app = express();
app.use(express.json());

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
]);

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPrice(price) {
  if (typeof price !== 'number' && typeof price !== 'string') {
    return false;
  }

  const normalized = String(price).trim();
  return /^\d+(\.\d{1,2})?$/.test(normalized);
}

function normalizeAddress2(address2) {
  return address2 === undefined ? null : address2;
}

function formatCustomer(row) {
  return {
    id: Number(row.id),
    userId: row.userid,
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
    ISBN: row.isbn,
    title: row.title,
    Author: row.author,
    description: row.description,
    genre: row.genre,
    price: Number(row.price),
    quantity: Number(row.quantity),
    summary: row.summary
  };
}

function buildFallbackSummary(book) {
  return `${book.title} is a ${book.genre} book written by ${book.Author}. ${book.description} The book presents its subject in a structured and engaging way, helping readers understand its main ideas, themes, and context. It offers readers a useful overview of the material and serves as an accessible introduction for anyone interested in this topic.`;
}

async function generateSummary(book) {
  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-latest';

  const fallback = buildFallbackSummary(book);

  if (!token) {
    console.error('ANTHROPIC_AUTH_TOKEN is missing');
    return fallback;
  }

  try {
    const prompt = `Write a clear and professional book summary of about 500 words based on the information below.

Title: ${book.title}
Author: ${book.Author}
Description: ${book.description}
Genre: ${book.genre}

Return only the summary text.`;

    const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;

    const response = await axios.post(
      url,
      {
        model,
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 20000,
        validateStatus: () => true
      }
    );

    const contentType = response.headers['content-type'] || '';

    if (response.status < 200 || response.status >= 300) {
      console.error('LLM summary error status:', response.status);
      console.error('LLM summary error body:', response.data);
      return fallback;
    }

    if (typeof response.data === 'string' || !contentType.includes('application/json')) {
      console.error('Unexpected non-JSON response from LLM endpoint:', response.data);
      return fallback;
    }

    const text = response.data?.content?.[0]?.text;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      console.error('No summary text returned:', response.data);
      return fallback;
    }

    return text.trim();
  } catch (err) {
    console.error('LLM summary error:', err.response?.data || err.message);
    return fallback;
  }
}

async function updateBookSummaryAsync(book) {
  try {
    const summary = await generateSummary(book);
    await pool.query(
      'UPDATE Books SET summary = $1 WHERE ISBN = $2',
      [summary, book.ISBN]
    );
  } catch (err) {
    console.error('Async summary update error:', err);
  }
}

app.get('/', (req, res) => {
  res.status(200).send('Bookstore API is running');
});

app.get('/status', (req, res) => {
  res.type('text/plain').status(200).send('OK');
});

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

    const existing = await pool.query(
      'SELECT id FROM Customers WHERE userId = $1',
      [userId]
    );

    if (existing.rows.length > 0) {
      return res.status(422).json({
        message: 'This user ID already exists in the system.'
      });
    }

    const storedAddress2 = normalizeAddress2(address2);

    const result = await pool.query(
      `INSERT INTO Customers (userId, name, phone, address, address2, city, state, zipcode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [userId, name, phone, address, storedAddress2, city, state, zipcode]
    );

    const newId = result.rows[0].id;

    return res.status(201).location(`/customers/${newId}`).json({
      id: Number(newId),
      userId,
      name,
      phone,
      address,
      address2: storedAddress2,
      city,
      state,
      zipcode
    });
  } catch (err) {
    console.error('POST /customers error:', err);
    return res.status(400).end();
  }
});

app.get('/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
      return res.status(400).end();
    }

    const result = await pool.query(
      `SELECT id, userId, name, phone, address, address2, city, state, zipcode
       FROM Customers
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).end();
    }

    return res.status(200).json(formatCustomer(result.rows[0]));
  } catch (err) {
    console.error('GET /customers/:id error:', err);
    return res.status(400).end();
  }
});

app.get('/customers', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || !isValidEmail(userId)) {
      return res.status(400).end();
    }

    const result = await pool.query(
      `SELECT id, userId, name, phone, address, address2, city, state, zipcode
       FROM Customers
       WHERE userId = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).end();
    }

    return res.status(200).json(formatCustomer(result.rows[0]));
  } catch (err) {
    console.error('GET /customers error:', err);
    return res.status(400).end();
  }
});

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

    const existing = await pool.query(
      'SELECT ISBN FROM Books WHERE ISBN = $1',
      [ISBN]
    );

    if (existing.rows.length > 0) {
      return res.status(422).json({
        message: 'This ISBN already exists in the system.'
      });
    }

    const bookForSummary = { ISBN, title, Author, description, genre };
    const initialSummary = buildFallbackSummary(bookForSummary);

    await pool.query(
      `INSERT INTO Books (ISBN, title, Author, description, genre, price, quantity, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ISBN, title, Author, description, genre, Number(price), Number(quantity), initialSummary]
    );

    updateBookSummaryAsync(bookForSummary);

    return res.status(201).location(`/books/${ISBN}`).json({
      ISBN,
      title,
      Author,
      description,
      genre,
      price: Number(price),
      quantity: Number(quantity)
    });
  } catch (err) {
    console.error('POST /books error:', err);
    return res.status(400).end();
  }
});

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

    if (pathISBN !== ISBN) {
      return res.status(400).end();
    }

    if (!isValidPrice(price)) {
      return res.status(400).end();
    }

    const existing = await pool.query(
      'SELECT ISBN FROM Books WHERE ISBN = $1',
      [pathISBN]
    );

    if (existing.rows.length === 0) {
      return res.status(404).end();
    }

    await pool.query(
      `UPDATE Books
       SET ISBN = $1, title = $2, Author = $3, description = $4, genre = $5, price = $6, quantity = $7
       WHERE ISBN = $8`,
      [ISBN, title, Author, description, genre, Number(price), Number(quantity), pathISBN]
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
    const result = await pool.query(
      `SELECT ISBN, title, Author, description, genre, price, quantity, summary
       FROM Books
       WHERE ISBN = $1`,
      [ISBN]
    );

    if (result.rows.length === 0) {
      return res.status(404).end();
    }

    return res.status(200).json(formatBook(result.rows[0]));
  } catch (err) {
    console.error('GET book error:', err);
    return res.status(400).end();
  }
}

app.get('/books/isbn/:ISBN', async (req, res) => {
  return getBookByISBN(res, req.params.ISBN);
});

app.get('/books/:ISBN', async (req, res) => {
  return getBookByISBN(res, req.params.ISBN);
});

module.exports = app;
