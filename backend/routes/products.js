import express from 'express';
import { query } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Helper to format product row
const formatProductRow = (row) => ({
  id: String(row.id),
  name: row.name,
  tamil: row.tamil,
  price: parseFloat(row.price),
  per: row.per,
  tags: Array.isArray(row.tags) ? row.tags : (typeof row.tags === 'string' ? JSON.parse(row.tags) : []),
  img: row.img || '',
  catalog_key: row.catalog_key,
  category_title: row.category_title,
  is_active: row.is_active,
  sort_order: row.sort_order,
});

// GET /api/products - Returns catalog grouped by category or flat
router.get('/', async (req, res) => {
  try {
    const { format, include_inactive } = req.query;

    const condition = include_inactive === 'true' ? '' : 'WHERE is_active = TRUE';
    const sql = `
      SELECT id, catalog_key, category_title, name, tamil, price, per, tags, img, sort_order, is_active
      FROM products
      ${condition}
      ORDER BY sort_order ASC, id ASC;
    `;

    const result = await query(sql);
    const rows = result.rows.map(formatProductRow);

    if (format === 'flat') {
      return res.json({
        success: true,
        count: rows.length,
        products: rows,
      });
    }

    // Group items by category to match the exact frontend structure
    const categoryMap = new Map();

    for (const item of rows) {
      if (!categoryMap.has(item.catalog_key)) {
        categoryMap.set(item.catalog_key, {
          key: item.catalog_key,
          title: item.category_title,
          items: [],
        });
      }

      categoryMap.get(item.catalog_key).items.push({
        id: item.id,
        name: item.name,
        tamil: item.tamil,
        price: item.price,
        per: item.per,
        tags: item.tags,
        img: item.img,
        ...(include_inactive === 'true' ? { is_active: item.is_active } : {}),
      });
    }

    const groupedCatalog = Array.from(categoryMap.values());
    return res.json(groupedCatalog);
  } catch (err) {
    console.error('Error fetching products:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve products from database.',
    });
  }
});

// GET /api/products/:id - Returns a single product
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      'SELECT id, catalog_key, category_title, name, tamil, price, per, tags, img, sort_order, is_active FROM products WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Product with ID '${id}' not found.`,
      });
    }

    return res.json({
      success: true,
      product: formatProductRow(result.rows[0]),
    });
  } catch (err) {
    console.error(`Error fetching product ${req.params.id}:`, err);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve product details.',
    });
  }
});

// PUT /api/products/:id - Admin-only update
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, tamil, price, per, img, tags, is_active } = req.body;

    // Check if product exists
    const existing = await query('SELECT * FROM products WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Product with ID '${id}' not found.`,
      });
    }

    const current = existing.rows[0];

    const updatedName = name !== undefined ? String(name).trim() : current.name;
    const updatedTamil = tamil !== undefined ? String(tamil).trim() : current.tamil;
    const updatedPrice = price !== undefined ? Number(price) : Number(current.price);
    const updatedPer = per !== undefined ? String(per).trim() : current.per;
    const updatedImg = img !== undefined ? String(img).trim() : current.img;
    const updatedTags = tags !== undefined ? JSON.stringify(tags) : JSON.stringify(current.tags || []);
    const updatedActive = is_active !== undefined ? Boolean(is_active) : current.is_active;

    if (!updatedName || !updatedTamil || !updatedPer) {
      return res.status(400).json({
        success: false,
        error: 'Name, Tamil description, and packaging unit cannot be empty.',
      });
    }

    if (!Number.isFinite(updatedPrice) || updatedPrice < 0) {
      return res.status(400).json({
        success: false,
        error: 'Price must be a valid non-negative number.',
      });
    }

    const updateSql = `
      UPDATE products
      SET name = $1,
          tamil = $2,
          price = $3,
          per = $4,
          img = $5,
          tags = $6,
          is_active = $7,
          updated_at = NOW()
      WHERE id = $8
      RETURNING *;
    `;

    const result = await query(updateSql, [
      updatedName,
      updatedTamil,
      updatedPrice,
      updatedPer,
      updatedImg,
      updatedTags,
      updatedActive,
      id,
    ]);

    return res.json({
      success: true,
      message: 'Product updated successfully.',
      product: formatProductRow(result.rows[0]),
    });
  } catch (err) {
    console.error(`Error updating product ${req.params.id}:`, err);
    return res.status(500).json({
      success: false,
      error: 'Failed to update product in database.',
    });
  }
});

// POST /api/products - Admin-only creation
router.post('/', requireAuth, async (req, res) => {
  try {
    const { id, catalog_key, category_title, name, tamil, price, per, tags, img } = req.body;

    const numericPrice = Number(price);
    if (!catalog_key?.trim() || !category_title?.trim() || !name?.trim() || !tamil?.trim() || price === undefined || !per?.trim()) {
      return res.status(400).json({
        success: false,
        error: 'catalog_key, category_title, name, tamil, price, and per are required fields.',
      });
    }

    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      return res.status(400).json({
        success: false,
        error: 'Price must be a valid non-negative number.',
      });
    }

    // Determine ID if not provided
    let productId = id ? String(id).trim() : null;
    if (!productId) {
      const maxIdRes = await query(`
        SELECT MAX(CAST(id AS INTEGER)) as max_num FROM products WHERE id ~ '^\\d+$';
      `);
      const nextNum = (maxIdRes.rows[0]?.max_num || 0) + 1;
      productId = String(nextNum);
    }

    // Check uniqueness
    const checkRes = await query('SELECT id FROM products WHERE id = $1', [productId]);
    if (checkRes.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: `Product with ID '${productId}' already exists.`,
      });
    }

    // Calculate sort order
    const sortOrderRes = await query('SELECT COALESCE(MAX(sort_order), 0) + 1 as next_order FROM products');
    const nextOrder = sortOrderRes.rows[0].next_order;

    const insertSql = `
      INSERT INTO products (
        id, catalog_key, category_title, name, tamil, price, per, tags, img, sort_order, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
      RETURNING *;
    `;

    const result = await query(insertSql, [
      productId,
      catalog_key.trim(),
      category_title.trim(),
      name.trim(),
      tamil.trim(),
      numericPrice,
      per.trim(),
      JSON.stringify(tags || []),
      img ? img.trim() : '',
      nextOrder,
    ]);

    return res.status(201).json({
      success: true,
      message: 'Product created successfully.',
      product: formatProductRow(result.rows[0]),
    });
  } catch (err) {
    console.error('Error creating product:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to create product.',
    });
  }
});

// DELETE /api/products/:id - Admin-only delete or soft-delete
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { permanent } = req.query;

    if (permanent === 'true') {
      const delRes = await query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
      if (delRes.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: `Product with ID '${id}' not found.`,
        });
      }
      return res.json({
        success: true,
        message: `Product #${id} permanently deleted.`,
      });
    }

    // Soft delete by default
    const updateRes = await query(
      'UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id',
      [id]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Product with ID '${id}' not found.`,
      });
    }

    return res.json({
      success: true,
      message: `Product #${id} marked inactive.`,
    });
  } catch (err) {
    console.error(`Error deleting product ${req.params.id}:`, err);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete product.',
    });
  }
});

export default router;
