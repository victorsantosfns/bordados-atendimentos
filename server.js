require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS atendimentos (
        id           SERIAL PRIMARY KEY,
        filial       TEXT NOT NULL,
        atendente    TEXT,
        nome_cliente TEXT,
        ci           TEXT,
        cpf          TEXT,
        tipo_cli     TEXT,
        data_receb   TEXT,
        data_entrega TEXT,
        toalhas      JSONB DEFAULT '[]',
        produto      TEXT,
        qtde         INTEGER DEFAULT 0,
        cor_linha    TEXT,
        fonte        TEXT,
        epi          BOOLEAN DEFAULT FALSE,
        motivo_epi   TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Tabela atendimentos pronta.');
  } catch (err) {
    console.error('Erro ao inicializar banco:', err.message);
  }
}
initDB();

app.get('/api/atendimentos', async (req, res) => {
  try {
    const { filial } = req.query;
    let query, params;
    if (!filial || filial.toUpperCase() === 'CORP') {
      query = `SELECT * FROM atendimentos ORDER BY created_at DESC`;
      params = [];
    } else {
      query = `SELECT * FROM atendimentos WHERE filial = $1 ORDER BY created_at DESC`;
      params = [filial.toUpperCase()];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/atendimentos', async (req, res) => {
  try {
    const {
      filial, atendente, nomeCliente, ci, cpf, tipoCli,
      dataReceb, dataEntrega, toalhas, produto, qtde,
      corLinha, fonte, epi, motivoEpi
    } = req.body;
    if (!filial) return res.status(400).json({ error: 'Filial obrigatoria.' });
    const result = await pool.query(
      `INSERT INTO atendimentos
        (filial, atendente, nome_cliente, ci, cpf, tipo_cli,
         data_receb, data_entrega, toalhas, produto, qtde,
         cor_linha, fonte, epi, motivo_epi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        (filial || '').toUpperCase(),
        atendente || '',
        nomeCliente || '',
        ci || '',
        cpf || '',
        tipoCli || '',
        dataReceb || '',
        dataEntrega || '',
        JSON.stringify(toalhas || []),
        produto || '',
        parseInt(qtde) || 0,
        corLinha || '',
        fonte || '',
        epi === true || epi === 'true',
        motivoEpi || ''
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/atendimentos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      filial, atendente, nomeCliente, ci, cpf, tipoCli,
      dataReceb, dataEntrega, toalhas, produto, qtde,
      corLinha, fonte, epi, motivoEpi
    } = req.body;
    const result = await pool.query(
      `UPDATE atendimentos SET
      filial=$1, atendente=$2, nome_cliente=$3, ci=$4, cpf=$5, tipo_cli=$6,
      data_receb=$7, data_entrega=$8, toalhas=$9::jsonb, produto=$10, qtde=$11,
      cor_linha=$12, fonte=$13, epi=$14, motivo_epi=$15
      WHERE id=$16
      RETURNING *`,
      [
        (filial || '').toUpperCase(),
        atendente || '',
        nomeCliente || '',
        ci || '',
        cpf || '',
        tipoCli || '',
        dataReceb || '',
        dataEntrega || '',
        JSON.stringify(toalhas || []),
        produto || '',
        parseInt(qtde) || 0,
        corLinha || '',
        fonte || '',
        epi === true || epi === 'true',
        motivoEpi || '',
        id
        ]
      );
    if (!result.rows.length) return res.status(404).json({ error: 'Atendimento nao encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/atendimentos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM atendimentos WHERE id=$1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Atendimento nao encontrado.' });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
