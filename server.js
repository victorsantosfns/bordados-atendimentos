require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');

// 08/09/2026, pedido do Victor: toda matricula vinculada pela primeira vez
// (e o proprio corp, ver DEFAULT_PW no front) comeca com esta senha unica,
// e a pessoa e obrigada a trocar logo em seguida (ver senha_temporaria).
const SENHA_PADRAO_COLABORADOR = 'bordados2026';

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
                        id SERIAL PRIMARY KEY,
                                filial TEXT NOT NULL,
                                        atendente TEXT,
                                                nome_cliente TEXT,
                                                        ci TEXT,
                                                                cpf TEXT,
                                                                        tipo_cli TEXT,
                                                                                data_receb TEXT,
                                                                                        data_entrega TEXT,
                                                                                                toalhas JSONB DEFAULT '[]',
                                                                                                        produto TEXT,
                                                                                                                qtde INTEGER DEFAULT 0,
                                                                                                                        cor_linha TEXT,
                                                                                                                                fonte TEXT,
                                                                                                                                        epi BOOLEAN DEFAULT FALSE,
                                                                                                                                                motivo_epi TEXT,
                                                                                                                                                        created_at TIMESTAMPTZ DEFAULT NOW()
                                                                                                                                                              );
                                                                                                                                                                  `);
          await pool.query(`
                CREATE TABLE IF NOT EXISTS colaboradores (
                        id SERIAL PRIMARY KEY,
                                nome TEXT NOT NULL,
                                        filial TEXT NOT NULL,
                                                cargo TEXT,
                                                        telefone TEXT,
                                                                ativo BOOLEAN DEFAULT TRUE,
                                                                        created_at TIMESTAMPTZ DEFAULT NOW()
                                                                              );
                                                                                  `);
          // 04/09/2026, pedido do Victor: login individual por colaborador
          // (matricula + filial + senha), no lugar da senha unica por filial
          // que ficava so no navegador. ADD COLUMN IF NOT EXISTS preserva os
          // 33 colaboradores ja cadastrados sem perder nada - eles so ficam
          // com matricula/senha_hash nulos ate "vincularem" o proprio nome
          // no primeiro acesso (ver /api/colaboradores/login e /vincular).
          await pool.query(`ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS matricula TEXT`);
          await pool.query(`ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS senha_hash TEXT`);
          // Indice unico parcial: matricula so precisa ser unica DENTRO da
          // mesma filial, e nao trava colaboradores ainda sem matricula
          // (varios NULL sao permitidos num indice unico parcial).
          await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS colaboradores_filial_matricula_uniq
                             ON colaboradores(filial, matricula) WHERE matricula IS NOT NULL`);
          // 08/09/2026, pedido do Victor: todo primeiro acesso recebe a MESMA
          // senha padrao (SENHA_PADRAO_COLABORADOR) em vez do colaborador
          // escolher a propria senha na hora - e fica marcado como temporaria
          // ate a pessoa trocar por uma senha propria (ver /login e
          // /trocar-senha). Sem coluna nenhum colaborador antigo e afetado
          // (fica FALSE, ou seja, ja tem senha definitiva).
          await pool.query(`ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS senha_temporaria BOOLEAN DEFAULT FALSE`);
          console.log('Tabelas prontas.');
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
    if (!Array.isArray(toalhas) || toalhas.length === 0) return res.status(400).json({ error: 'Informe ao menos uma toalha.' });
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

// ── Login individual por colaborador (04/09/2026) ──────────────────────────
// Matricula + Filial + Senha. Senha fica com hash bcrypt no banco (nunca em
// texto puro), validada aqui no servidor - substitui a senha unica por
// filial que antes so existia no localStorage do navegador.
app.post('/api/colaboradores/login', async (req, res) => {
  try {
    const { filial, matricula, senha } = req.body;
    if (!filial || !matricula || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe filial, matricula e senha.' });
    }
    const filialUp = filial.toUpperCase();
    const result = await pool.query(
      `SELECT * FROM colaboradores WHERE filial=$1 AND matricula=$2 AND ativo=TRUE`,
      [filialUp, matricula.trim()]
    );
    if (!result.rows.length) {
      // Matricula ainda nao vinculada a nenhum cadastro desta filial - pode
      // ser um colaborador antigo (dos 33 ja existentes) que ainda nao fez
      // o primeiro acesso. O front oferece a tela de "selecionar seu nome".
      return res.status(404).json({ ok: false, erro: 'Matricula nao encontrada nesta filial.', precisaVincular: true });
    }
    const colab = result.rows[0];
    if (!colab.senha_hash) {
      // Matricula ja tinha sido gravada nesse colaborador mas sem senha
      // ainda definida (estado intermediario, nao deveria acontecer no fluxo
      // normal ja que /vincular grava os dois juntos) - aplica a senha
      // padrao aqui tambem, por consistencia, ignorando o que foi digitado.
      const hash = await bcrypt.hash(SENHA_PADRAO_COLABORADOR, 10);
      await pool.query(`UPDATE colaboradores SET senha_hash=$1, senha_temporaria=TRUE WHERE id=$2`, [hash, colab.id]);
      return res.json({ ok: true, id: colab.id, nome: colab.nome, filial: colab.filial, cargo: colab.cargo, precisaTrocarSenha: true });
    }
    const confere = await bcrypt.compare(senha, colab.senha_hash);
    if (!confere) return res.status(401).json({ ok: false, erro: 'Senha incorreta.' });
    res.json({ ok: true, id: colab.id, nome: colab.nome, filial: colab.filial, cargo: colab.cargo, precisaTrocarSenha: !!colab.senha_temporaria });
  } catch (err) {
    console.error('POST colaboradores/login error:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Colaboradores desta filial que ainda nao vincularam matricula/senha - usado
// na tela "primeiro acesso: selecione seu nome" quando a matricula digitada
// nao bate com nada ainda (cobre os 33 cadastros que ja existiam antes desta
// mudanca, sem precisar o Victor digitar a matricula de cada um manualmente).
app.get('/api/colaboradores/sem-matricula', async (req, res) => {
  try {
    const { filial } = req.query;
    if (!filial) return res.status(400).json({ error: 'Informe a filial.' });
    const result = await pool.query(
      `SELECT id, nome, cargo FROM colaboradores WHERE filial=$1 AND ativo=TRUE AND matricula IS NULL ORDER BY nome ASC`,
      [filial.toUpperCase()]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET colaboradores/sem-matricula error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Vincula matricula a um cadastro de colaborador ja existente (primeiro
// acesso de alguem dos 33 que ja estavam cadastrados só pelo nome). Nao cria
// registro novo nem mexe em nenhum atendimento ja lancado - so completa o
// cadastro que ja existia. A senha NAO vem do colaborador (pedido do Victor,
// 08/09/2026) - todo mundo comeca com SENHA_PADRAO_COLABORADOR e e forcado a
// trocar logo depois (ver senha_temporaria, checado no /login e usado pelo
// front pra abrir a tela "Trocar Senha" antes de liberar o app).
app.post('/api/colaboradores/:id/vincular', async (req, res) => {
  try {
    const { id } = req.params;
    const { matricula } = req.body;
    if (!matricula) return res.status(400).json({ ok: false, erro: 'Informe a matricula.' });
    const existe = await pool.query('SELECT id FROM colaboradores WHERE id=$1', [id]);
    if (!existe.rows.length) return res.status(404).json({ ok: false, erro: 'Colaborador nao encontrado.' });
    const hash = await bcrypt.hash(SENHA_PADRAO_COLABORADOR, 10);
    try {
      const result = await pool.query(
        `UPDATE colaboradores SET matricula=$1, senha_hash=$2, senha_temporaria=TRUE WHERE id=$3 RETURNING id, nome, filial, cargo`,
        [matricula.trim(), hash, id]
      );
      res.json({ ok: true, ...result.rows[0], precisaTrocarSenha: true });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ ok: false, erro: 'Essa matricula ja esta em uso nesta filial.' });
      throw e;
    }
  } catch (err) {
    console.error('POST colaboradores/vincular error:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Troca de senha (fluxo obrigatorio apos vincular/receber a senha padrao, ou
// uso espontaneo depois). Exige a senha atual pra confirmar identidade -
// nesse app sem sessao/token, e a unica trava real contra alguem trocar a
// senha de outro colaborador so sabendo o id (que nao e secreto, aparece na
// listagem publica de colaboradores).
app.post('/api/colaboradores/:id/trocar-senha', async (req, res) => {
  try {
    const { id } = req.params;
    const { senhaAtual, senhaNova } = req.body;
    if (!senhaAtual || !senhaNova) return res.status(400).json({ ok: false, erro: 'Informe a senha atual e a nova senha.' });
    if (senhaNova.length < 6) return res.status(400).json({ ok: false, erro: 'A nova senha precisa ter no minimo 6 caracteres.' });
    if (senhaNova === SENHA_PADRAO_COLABORADOR) return res.status(400).json({ ok: false, erro: 'Escolha uma senha diferente da senha padrao.' });

    const result = await pool.query('SELECT senha_hash FROM colaboradores WHERE id=$1', [id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, erro: 'Colaborador nao encontrado.' });

    const confere = await bcrypt.compare(senhaAtual, result.rows[0].senha_hash || '');
    if (!confere) return res.status(401).json({ ok: false, erro: 'Senha atual incorreta.' });

    const hash = await bcrypt.hash(senhaNova, 10);
    await pool.query(`UPDATE colaboradores SET senha_hash=$1, senha_temporaria=FALSE WHERE id=$2`, [hash, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST colaboradores/trocar-senha error:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Reseta o acesso de um colaborador (admin/corp) - limpa matricula e senha
// pra ele refazer o "primeiro acesso" do zero, sem apagar o cadastro nem
// nenhum atendimento ja lancado em nome dele.
app.post('/api/colaboradores/:id/resetar-acesso', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE colaboradores SET matricula=NULL, senha_hash=NULL WHERE id=$1 RETURNING id, nome, filial`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, erro: 'Colaborador nao encontrado.' });
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) {
    console.error('POST colaboradores/resetar-acesso error:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/api/colaboradores', async (req, res) => {
  try {
    const { filial } = req.query;
    let query, params;
    if (!filial || filial.toUpperCase() === 'CORP') {
      query = `SELECT * FROM colaboradores ORDER BY nome ASC`;
      params = [];
    } else {
      query = `SELECT * FROM colaboradores WHERE filial = $1 ORDER BY nome ASC`;
      params = [filial.toUpperCase()];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET colaboradores error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/colaboradores', async (req, res) => {
  try {
    const { nome, filial, cargo, telefone } = req.body;
    if (!nome || !filial) return res.status(400).json({ error: 'Nome e filial sao obrigatorios.' });
    const result = await pool.query(
      `INSERT INTO colaboradores (nome, filial, cargo, telefone) VALUES ($1,$2,$3,$4) RETURNING *`,
      [nome, (filial || '').toUpperCase(), cargo || '', telefone || '']
      );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST colaboradores error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/colaboradores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, filial, cargo, telefone, ativo } = req.body;
    const result = await pool.query(
      `UPDATE colaboradores SET nome=$1, filial=$2, cargo=$3, telefone=$4, ativo=$5 WHERE id=$6 RETURNING *`,
      [nome || '', (filial || '').toUpperCase(), cargo || '', telefone || '', ativo !== false, id]
      );
    if (!result.rows.length) return res.status(404).json({ error: 'Colaborador nao encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT colaboradores error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/colaboradores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM colaboradores WHERE id=$1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Colaborador nao encontrado.' });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('DELETE colaboradores error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
