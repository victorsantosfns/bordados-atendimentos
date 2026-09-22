require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');

// 08/09/2026, pedido do Victor: toda matricula vinculada pela primeira vez
// comeca com esta senha unica, e a pessoa e obrigada a trocar logo em
// seguida (ver senha_temporaria). 23/09/2026, achado do QA (Coringa): este
// repositorio e publico no GitHub — nunca mais hardcode aqui, configure
// SENHA_PADRAO_COLABORADOR nas variaveis de ambiente do Render. O fallback
// so existe pra nao quebrar em dev local sem .env; troque a env var em
// producao mesmo que o fallback pareca "funcionar".
const SENHA_PADRAO_COLABORADOR = process.env.SENHA_PADRAO_COLABORADOR || 'bordados2026';
// 23/09/2026, mesmo achado: codigo de reset da senha "corp" tambem estava
// hardcoded (era o mesmo texto de SENHA_PADRAO_COLABORADOR).
const RESET_CODE_CORP = process.env.RESET_CODE_CORP || 'bordados2026';

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

          // 23/09/2026, achado do QA (Coringa): login "corp" (administrativo)
          // era validado só no navegador, com a senha guardada em texto puro
          // no localStorage — qualquer um abre o DevTools e entra sem senha
          // real nenhuma. Migra pra validação no servidor, mesmo padrão de
          // hash bcrypt já usado pros colaboradores de filial. Tabela
          // genérica (chave/valor) porque é a única config assim por ora.
          await pool.query(`CREATE TABLE IF NOT EXISTS config_sistema (chave TEXT PRIMARY KEY, valor TEXT)`);
          const corpCfg = await pool.query(`SELECT valor FROM config_sistema WHERE chave = 'senha_corp_hash'`);
          if (!corpCfg.rows.length) {
            // Semente inicial: mesma senha que já era o padrão de fato hoje
            // (bor_pw_corp no localStorage começava com '123456') — marcada
            // temporária, então quem entrar primeiro já é forçado a trocar.
            const hashCorp = await bcrypt.hash('123456', 10);
            await pool.query(
              `INSERT INTO config_sistema (chave, valor) VALUES ('senha_corp_hash', $1) ON CONFLICT DO NOTHING`,
              [hashCorp]
            );
            await pool.query(
              `INSERT INTO config_sistema (chave, valor) VALUES ('senha_corp_temporaria', 'true') ON CONFLICT DO NOTHING`
            );
          }

          console.log('Tabelas prontas.');

          // 22/09/2026, pedido do Victor: app de captação de leads pra
          // Fesíndico Recife (feira 24/09, pesquisa 25-26/09) — reaproveita
          // este serviço (já público no Render, sem depender da rede interna
          // da FC) em vez de provisionar infraestrutura nova sob prazo
          // apertado. Tabelas isoladas por nome (leads_fesindico/cnpjs_fc),
          // não mexem em nada do fluxo de atendimentos.
          await criarTabelasFesindico();
    } catch (err) {
          console.error('Erro ao inicializar banco:', err.message);
    }
}
initDB();

async function criarTabelasFesindico() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads_fesindico (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL,
      cnpj TEXT,
      cnpj_encontrado BOOLEAN,
      nome_empresa TEXT,
      cidade TEXT,
      nome_contato TEXT,
      whatsapp TEXT,
      telefone TEXT,
      email TEXT,
      segmento TEXT,
      produtos JSONB DEFAULT '[]',
      oportunidade TEXT,
      urgencia TEXT,
      atualizar_dados BOOLEAN,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Base de CNPJ ativos da Ferreira Costa (MAXXON.CLIE — 159.225 registros)
  // — usada só pra identificar, na hora, se quem está respondendo já é
  // cliente cadastrado. Foto estática (não é ligação ao vivo com o Oracle,
  // que não é alcançável fora da rede FC). DELIBERADAMENTE não versionada
  // no repo (é uma exportação real de clientes da FC, e este repo é
  // público no GitHub) — importada uma vez via POST /api/admin/importar-cnpjs
  // (ver abaixo), protegido por CNPJ_IMPORT_TOKEN.
  await pool.query(`CREATE TABLE IF NOT EXISTS cnpjs_fc (cnpj TEXT PRIMARY KEY)`);
}

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
// cadastro que ja existia. 23/09/2026: o front agora pede a senha nova já
// nesta etapa (senhaNova), em vez de vincular com SENHA_PADRAO_COLABORADOR
// e depender do client reenviar esse valor pra trocar em seguida - evita o
// estado intermediario "senha padrao temporaria". Sem senhaNova (chamada
// antiga/compat), mantem o comportamento anterior.
app.post('/api/colaboradores/:id/vincular', async (req, res) => {
  try {
    const { id } = req.params;
    const { matricula, senhaNova } = req.body;
    if (!matricula) return res.status(400).json({ ok: false, erro: 'Informe a matricula.' });
    const existe = await pool.query('SELECT id FROM colaboradores WHERE id=$1', [id]);
    if (!existe.rows.length) return res.status(404).json({ ok: false, erro: 'Colaborador nao encontrado.' });
    // 23/09/2026, achado do Coringa (2ª validação): faltava o mesmo guard
    // que /trocar-senha já tem — sem isso, quem digitasse a própria senha
    // padrão como "senha nova" ficaria permanentemente nela, sem nunca ser
    // forçado a trocar.
    if (senhaNova && senhaNova.length >= 6 && senhaNova === SENHA_PADRAO_COLABORADOR) {
      return res.status(400).json({ ok: false, erro: 'Escolha uma senha diferente da senha padrão.' });
    }
    let hash, temporaria;
    if (senhaNova && senhaNova.length >= 6) {
      hash = await bcrypt.hash(senhaNova, 10);
      temporaria = false;
    } else {
      hash = await bcrypt.hash(SENHA_PADRAO_COLABORADOR, 10);
      temporaria = true;
    }
    try {
      const result = await pool.query(
        `UPDATE colaboradores SET matricula=$1, senha_hash=$2, senha_temporaria=$3 WHERE id=$4 RETURNING id, nome, filial, cargo`,
        [matricula.trim(), hash, temporaria, id]
      );
      res.json({ ok: true, ...result.rows[0], precisaTrocarSenha: temporaria });
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

// 23/09/2026, achado do QA (Coringa): esta rota é pública (sem
// autenticação — o front chama de qualquer filial) e fazia SELECT *,
// devolvendo senha_hash (bcrypt) e senha_temporaria de todo mundo pra
// qualquer visitante. matricula continua aqui de propósito (a tela de
// gestão de colaboradores exibe "Vinculado (matrícula)" legitimamente).
const COLABORADOR_COLUNAS_PUBLICAS = 'id, nome, filial, cargo, telefone, ativo, created_at, matricula';
app.get('/api/colaboradores', async (req, res) => {
  try {
    const { filial } = req.query;
    let query, params;
    if (!filial || filial.toUpperCase() === 'CORP') {
      query = `SELECT ${COLABORADOR_COLUNAS_PUBLICAS} FROM colaboradores ORDER BY nome ASC`;
      params = [];
    } else {
      query = `SELECT ${COLABORADOR_COLUNAS_PUBLICAS} FROM colaboradores WHERE filial = $1 ORDER BY nome ASC`;
      params = [filial.toUpperCase()];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET colaboradores error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Login "corp" (administrativo) — validado no servidor (23/09/2026) ──────
app.post('/api/corp/login', async (req, res) => {
  try {
    const { senha } = req.body;
    if (!senha) return res.status(400).json({ ok: false, erro: 'Digite a senha.' });
    const cfg = await pool.query(`SELECT valor FROM config_sistema WHERE chave = 'senha_corp_hash'`);
    if (!cfg.rows.length) return res.status(500).json({ ok: false, erro: 'Senha corp ainda não configurada.' });
    const confere = await bcrypt.compare(senha, cfg.rows[0].valor);
    if (!confere) return res.status(401).json({ ok: false, erro: 'Senha incorreta.' });
    const tempCfg = await pool.query(`SELECT valor FROM config_sistema WHERE chave = 'senha_corp_temporaria'`);
    res.json({ ok: true, precisaTrocarSenha: tempCfg.rows.length ? tempCfg.rows[0].valor === 'true' : false });
  } catch (err) {
    console.error('POST corp/login error:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/api/corp/trocar-senha', async (req, res) => {
  try {
    const { senhaAtual, senhaNova } = req.body;
    if (!senhaAtual || !senhaNova) return res.status(400).json({ ok: false, erro: 'Informe a senha atual e a nova.' });
    if (senhaNova.length < 6) return res.status(400).json({ ok: false, erro: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    // 23/09/2026, achado do Coringa (validação): corp é a conta de maior
    // privilégio (todas as 9 filiais) — mesmo guard que já existe pro
    // colaborador, pra não permitir "trocar" pra senha padrão conhecida.
    if (senhaNova === SENHA_PADRAO_COLABORADOR) return res.status(400).json({ ok: false, erro: 'Escolha uma senha diferente da senha padrão.' });
    const cfg = await pool.query(`SELECT valor FROM config_sistema WHERE chave = 'senha_corp_hash'`);
    if (!cfg.rows.length) return res.status(500).json({ ok: false, erro: 'Senha corp ainda não configurada.' });
    const confere = await bcrypt.compare(senhaAtual, cfg.rows[0].valor);
    if (!confere) return res.status(401).json({ ok: false, erro: 'Senha atual incorreta.' });
    const hash = await bcrypt.hash(senhaNova, 10);
    await pool.query(`UPDATE config_sistema SET valor=$1 WHERE chave='senha_corp_hash'`, [hash]);
    await pool.query(`UPDATE config_sistema SET valor='false' WHERE chave='senha_corp_temporaria'`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST corp/trocar-senha error:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/api/corp/resetar-senha', async (req, res) => {
  try {
    const { codigoReset } = req.body;
    if (codigoReset !== RESET_CODE_CORP) return res.status(403).json({ ok: false, erro: 'Código de reset incorreto.' });
    const hash = await bcrypt.hash(SENHA_PADRAO_COLABORADOR, 10);
    await pool.query(`UPDATE config_sistema SET valor=$1 WHERE chave='senha_corp_hash'`, [hash]);
    await pool.query(`UPDATE config_sistema SET valor='true' WHERE chave='senha_corp_temporaria'`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST corp/resetar-senha error:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/api/colaboradores', async (req, res) => {
  try {
    const { nome, filial, cargo, telefone } = req.body;
    if (!nome || !filial) return res.status(400).json({ error: 'Nome e filial sao obrigatorios.' });
    // 23/09/2026, achado do Coringa (3ª validação): RETURNING * aqui e no
    // PUT abaixo vazavam senha_hash/senha_temporaria em toda escrita —
    // mesmo problema já corrigido no GET, esquecido nestas duas rotas.
    const result = await pool.query(
      `INSERT INTO colaboradores (nome, filial, cargo, telefone) VALUES ($1,$2,$3,$4) RETURNING ${COLABORADOR_COLUNAS_PUBLICAS}`,
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
      `UPDATE colaboradores SET nome=$1, filial=$2, cargo=$3, telefone=$4, ativo=$5 WHERE id=$6 RETURNING ${COLABORADOR_COLUNAS_PUBLICAS}`,
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

// ══ Fesíndico Recife — captação de leads (22/09/2026) ══
app.get('/fesindico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fesindico.html'));
});

// Importação protegida da base de CNPJ (rodar uma vez, manualmente, logo
// após o primeiro deploy — ver CNPJ_IMPORT_TOKEN nas variáveis de ambiente
// do Render). Aceita lotes (o chamador decide o tamanho) pra não estourar
// o limite de payload; pode ser chamada várias vezes, é idempotente
// (ON CONFLICT DO NOTHING).
app.post('/api/admin/importar-cnpjs', async (req, res) => {
  try {
    const token = req.headers['x-import-token'];
    if (!process.env.CNPJ_IMPORT_TOKEN || token !== process.env.CNPJ_IMPORT_TOKEN) {
      return res.status(403).json({ error: 'Token inválido.' });
    }
    const lista = Array.isArray(req.body.cnpjs) ? req.body.cnpjs.map(String).map(s => s.replace(/\D/g, '')).filter(s => s.length === 14) : [];
    if (!lista.length) return res.status(400).json({ error: 'Envie { cnpjs: ["14 digitos", ...] }.' });
    const valores = lista.map((_, i) => `($${i + 1})`).join(',');
    await pool.query(`INSERT INTO cnpjs_fc (cnpj) VALUES ${valores} ON CONFLICT DO NOTHING`, lista);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS qtd FROM cnpjs_fc');
    res.json({ ok: true, recebidos: lista.length, totalNaBase: rows[0].qtd });
  } catch (err) {
    console.error('POST importar-cnpjs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cnpj-existe/:cnpj', async (req, res) => {
  try {
    const cnpj = String(req.params.cnpj || '').replace(/\D/g, '');
    if (cnpj.length !== 14) return res.json({ existe: false });
    const r = await pool.query('SELECT 1 FROM cnpjs_fc WHERE cnpj = $1', [cnpj]);
    res.json({ existe: r.rows.length > 0 });
  } catch (err) {
    console.error('GET cnpj-existe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads-fesindico', async (req, res) => {
  try {
    const {
      tipo, cnpj, cnpjEncontrado, nomeEmpresa, cidade,
      nomeContato, whatsapp, telefone, email, segmento,
      produtos, oportunidade, urgencia, atualizarDados
    } = req.body;
    if (tipo !== 'novo' && tipo !== 'recorrente') {
      return res.status(400).json({ error: 'Campo "tipo" deve ser "novo" ou "recorrente".' });
    }
    const result = await pool.query(
      `INSERT INTO leads_fesindico
       (tipo, cnpj, cnpj_encontrado, nome_empresa, cidade, nome_contato,
        whatsapp, telefone, email, segmento, produtos, oportunidade, urgencia, atualizar_dados)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
       RETURNING id`,
      [
        tipo, cnpj || null, cnpjEncontrado === undefined ? null : !!cnpjEncontrado,
        nomeEmpresa || null, cidade || null, nomeContato || null,
        whatsapp || null, telefone || null, email || null, segmento || null,
        JSON.stringify(Array.isArray(produtos) ? produtos : []),
        oportunidade || null, urgencia || null,
        atualizarDados === undefined ? null : !!atualizarDados
      ]
    );
    res.status(201).json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('POST leads-fesindico error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
