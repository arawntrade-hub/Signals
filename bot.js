require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const path = require('path');

// ================== CONFIGURACIÓN ==================
const token = process.env.TELEGRAM_TOKEN;
const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()));
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const cubaTz = process.env.CUBA_TZ || 'America/Havana';
const BASE_URL = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
const PORT = process.env.PORT || 3000;

// Configuración de logs
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

// Inicializar bot con polling (sin webhook, Express en el mismo proceso)
const bot = new TelegramBot(token, { polling: true });

// Inicializar Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

// Crear bucket si no existe
async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets.find(b => b.name === 'payment-screenshots')) {
    await supabase.storage.createBucket('payment-screenshots', { public: true });
    logger.info('Bucket payment-screenshots creado');
  }
}
ensureBucket().catch(err => logger.error('Error creando bucket:', err));

// ================== UTILIDADES ==================
function isAdmin(telegramId) {
  return adminIds.includes(telegramId);
}

async function getOrCreateUser(telegramId, username) {
  let { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (error && error.code === 'PGRST116') {
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ telegram_id: telegramId, username }])
      .select()
      .single();
    if (insertError) throw insertError;
    return newUser;
  } else if (error) {
    throw error;
  }
  return user;
}

async function getUser(telegramId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

function getCubaNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: cubaTz }));
}

function isValidQuotexId(id) {
  return /^[a-zA-Z0-9]{6,20}$/.test(id);
}

// ================== MENÚ PRINCIPAL (BOTONES NATIVOS) ==================
const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '📊 Planes' }],
      [{ text: '📈 Estadísticas' }],
      [{ text: '📜 Historial' }],
      [{ text: '❓ Ayuda' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

const adminMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '📊 Planes' }],
      [{ text: '📈 Estadísticas' }],
      [{ text: '📜 Historial' }],
      [{ text: '❓ Ayuda' }],
      [{ text: '🔧 Admin' }]
    ],
    resize_keyboard: true
  }
};

// ================== ESTADOS PERSISTENTES EN SUPABASE ==================
async function setUserState(chatId, step, data = {}) {
  const { error } = await supabase
    .from('admin_states')
    .upsert({ chat_id: chatId, step, data }, { onConflict: 'chat_id' });
  if (error) throw error;
}

async function getUserState(chatId) {
  const { data, error } = await supabase
    .from('admin_states')
    .select('step, data')
    .eq('chat_id', chatId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function clearUserState(chatId) {
  const { error } = await supabase
    .from('admin_states')
    .delete()
    .eq('chat_id', chatId);
  if (error) throw error;
}

// ================== SUBIR IMAGEN A SUPABASE STORAGE ==================
async function uploadPhotoToSupabase(fileId, userId) {
  try {
    const fileLink = await bot.getFileLink(fileId);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');
    const fileName = `user_${userId}_${uuidv4()}.jpg`;
    const { data, error } = await supabase.storage
      .from('payment-screenshots')
      .upload(fileName, buffer, { contentType: 'image/jpeg' });
    if (error) throw error;
    const { data: urlData } = supabase.storage
      .from('payment-screenshots')
      .getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch (err) {
    logger.error(`Error subiendo imagen: ${err.message}`);
    throw err;
  }
}

// ================== IA (SOLO PREMIUM) ==================
async function askIA(userId, userMessage) {
  const { data: history } = await supabase
    .from('user_conversations')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  const messages = [
    {
      role: 'system',
      content: `Eres un asistente experto en trading de opciones binarias. 
Tus respuestas deben ser claras, educativas y en español. 
Puedes hablar sobre análisis técnico, fundamental, gestión de riesgo, psicología del trading, estrategias probadas, etc. 
Nunca des consejos de inversión personalizados ni prometas resultados. 
Si el usuario comparte una noticia, analiza su posible impacto en el mercado de forma objetiva.
Utiliza el historial de la conversación para mantener contexto y responder de manera coherente.`
    }
  ];

  if (history) {
    const reversed = history.reverse();
    for (const msg of reversed) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: 'user', content: userMessage });

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'stepfun/step-3.5-flash:free',
        messages,
        max_tokens: 1500,
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': `Bearer ${openRouterKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const reply = response.data.choices[0].message.content;

    await supabase.from('user_conversations').insert([
      { user_id: userId, role: 'user', content: userMessage },
      { user_id: userId, role: 'assistant', content: reply },
    ]);

    return reply;
  } catch (err) {
    logger.error(`Error en IA: ${err.message}`);
    throw err;
  }
}

// ================== COMANDO /START ==================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const username = msg.from.username;

  try {
    const user = await getOrCreateUser(telegramId, username);
    const keyboard = isAdmin(telegramId) ? adminMenuKeyboard : mainMenuKeyboard;
    await bot.sendMessage(
      chatId,
      '¡Bienvenido al bot de señales de trading!\nElige una opción:',
      keyboard
    );
  } catch (error) {
    logger.error(`Error en /start: ${error.message}`);
    await bot.sendMessage(chatId, 'Ocurrió un error. Intenta más tarde.');
  }
});

// ================== MANEJADOR DE MENSAJES DE TEXTO (MENÚ Y RESPUESTAS) ==================
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text;
  const telegramId = msg.from.id;

  try {
    // Si el usuario tiene un estado pendiente (ej. esperando ID de Quotex), lo procesamos primero
    const state = await getUserState(chatId);
    if (state) {
      if (state.step === 'awaiting_quotex_free' || state.step === 'awaiting_quotex_premium') {
        await handleQuotexResponse(chatId, telegramId, text, state.step);
        return;
      }
      // Si no es un estado conocido, lo ignoramos y limpiamos? mejor limpiar
      await clearUserState(chatId);
    }

    // Si no hay estado, procesamos opciones del menú
    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, 'Usa /start primero.');

    if (text === '📊 Planes') {
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Plan Básico (gratis)', callback_data: 'plan_free' }],
          [{ text: 'Plan Premium (3000 CUP/mes)', callback_data: 'plan_premium' }],
        ],
      };
      await bot.sendMessage(chatId, 'Elige un plan:', { reply_markup: keyboard });
    }
    else if (text === '📈 Estadísticas') {
      await handleEstadisticas(chatId, user);
    }
    else if (text === '📜 Historial') {
      await handleHistorial(chatId, user);
    }
    else if (text === '❓ Ayuda') {
      await bot.sendMessage(chatId, 'Usa /start para ver el menú. Si tienes dudas, contacta al admin.');
    }
    else if (text === '🔧 Admin' && isAdmin(telegramId)) {
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Abrir sesión manual', callback_data: 'admin_open_session' }],
          [{ text: 'Cerrar sesión', callback_data: 'admin_close_session' }],
          [{ text: 'Nueva señal', callback_data: 'admin_new_signal' }],
          [{ text: 'Ver solicitudes pendientes', callback_data: 'admin_pending_requests' }],
          [{ text: 'Resultados pendientes', callback_data: 'admin_pending_results' }],
          [{ text: '📋 Panel web', url: `${BASE_URL}/admin?telegram_id=${telegramId}` }]
        ],
      };
      await bot.sendMessage(chatId, 'Panel de admin:', { reply_markup: keyboard });
    }
  } catch (error) {
    logger.error(`Error en message handler: ${error.message}`);
    await bot.sendMessage(chatId, 'Error interno.');
  }
});

// Función para manejar la respuesta del ID de Quotex
async function handleQuotexResponse(chatId, telegramId, quotexId, step) {
  if (!isValidQuotexId(quotexId)) {
    return bot.sendMessage(chatId, '❌ ID de Quotex no válido. Debe tener 6-20 caracteres alfanuméricos. Intenta de nuevo.');
  }

  const user = await getUser(telegramId);
  if (!user) return bot.sendMessage(chatId, 'Error: usuario no encontrado.');

  await supabase.from('users').update({ quotex_id: quotexId }).eq('id', user.id);

  const { data: req, error } = await supabase
    .from('membership_requests')
    .insert([{
      user_id: user.id,
      type: step === 'awaiting_quotex_free' ? 'free' : 'premium',
      status: 'pending'
    }])
    .select()
    .single();

  if (error) throw error;

  await bot.sendMessage(chatId, '✅ ID recibido. Tu solicitud ha sido enviada al admin. Espera la confirmación.');
  await clearUserState(chatId);

  // Notificar a los admins
  for (const adminId of adminIds) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Aprobar', callback_data: `approve_${req.id}` },
          { text: '❌ Rechazar', callback_data: `reject_${req.id}` }
        ]
      ]
    };
    await bot.sendMessage(
      adminId,
      `Nueva solicitud de @${msg.from.username || telegramId}\n`
      + `Tipo: ${req.type}\n`
      + `ID Quotex: ${quotexId}\n`
      + `Para gestionar, usa el panel web: ${BASE_URL}/admin?telegram_id=${adminId}`,
      { reply_markup: keyboard }
    );
  }
}

// Funciones auxiliares para estadísticas e historial
async function handleEstadisticas(chatId, user) {
  let query = supabase.from('signals').select('*');
  if (user.membership === 'free') {
    query = query.gte('created_at', user.created_at);
  }
  const { data: signals, error } = await query;
  if (error) throw error;

  const total = signals.length;
  if (total === 0) {
    return bot.sendMessage(chatId, 'No hay suficientes datos aún.');
  }

  const profits = signals.filter(s => s.result === 'profit').length;
  const losses = signals.filter(s => s.result === 'loss').length;
  const winrate = total > 0 ? ((profits / total) * 100).toFixed(2) : 0;

  let texto = `📊 *Estadísticas ${user.membership === 'premium' ? 'PREMIUM' : 'BÁSICAS'}*\n`;
  texto += `Señales totales: ${total}\n`;
  texto += `Profit: ${profits}\n`;
  texto += `Loss: ${losses}\n`;
  texto += `Winrate: ${winrate}%\n`;
  texto += `Pendientes: ${total - profits - losses}`;

  await bot.sendMessage(chatId, texto, { parse_mode: 'Markdown' });
}

async function handleHistorial(chatId, user) {
  const { data: deliveries, error } = await supabase
    .from('signal_deliveries')
    .select(`
      signal:signals!inner(signal_index, asset, timeframe, direction, result)
    `)
    .eq('user_id', user.id)
    .order('delivered_at', { ascending: false })
    .limit(10);

  if (error) throw error;
  if (!deliveries.length) {
    return bot.sendMessage(chatId, 'Aún no has recibido señales.');
  }

  const lines = deliveries.map(d => {
    const s = d.signal;
    const emoji = s.direction === 'up' ? '⬆️' : '⬇️';
    const result = s.result ? ` - ${s.result}` : '';
    return `#${s.signal_index} ${s.asset} ${s.timeframe} ${emoji}${result}`;
  });
  await bot.sendMessage(chatId, '📜 *Últimas señales:*\n' + lines.join('\n'), { parse_mode: 'Markdown' });
}

// ================== MANEJADOR DE CALLBACKS (INLINE) ==================
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = msg.chat.id;
  const telegramId = callbackQuery.from.id;
  const messageId = msg.message_id;

  await bot.answerCallbackQuery(callbackQuery.id);

  try {
    const user = await getOrCreateUser(telegramId, callbackQuery.from.username);

    // ===== PLANES (INICIO DEL FLUJO) =====
    if (data === 'plan_free') {
      await bot.editMessageText(
        'Para el plan básico, necesitas:\n'
        + '1. Registrarte en Quotex con este enlace: [ENLACE_DE_REFERIDO]\n'
        + '2. Una vez registrado, responde a este mensaje con tu ID de Quotex.',
        { chat_id: chatId, message_id: messageId }
      );
      await setUserState(chatId, 'awaiting_quotex_free', { userId: user.id });
    }
    else if (data === 'plan_premium') {
      await bot.editMessageText(
        'Para el plan premium, necesitas:\n'
        + '1. Registrarte en Quotex con este enlace: [ENLACE_DE_REFERIDO]\n'
        + '2. Una vez registrado, responde a este mensaje con tu ID de Quotex.',
        { chat_id: chatId, message_id: messageId }
      );
      await setUserState(chatId, 'awaiting_quotex_premium', { userId: user.id });
    }

    // ===== ADMIN: APROBAR/RECHAZAR (SOLO ADMIN) =====
    else if (data.startsWith('approve_') && isAdmin(telegramId)) {
      const reqId = parseInt(data.split('_')[1]);
      const { data: req, error } = await supabase
        .from('membership_requests')
        .select('*, user:users(*)')
        .eq('id', reqId)
        .single();

      if (error || !req) return bot.editMessageText('Solicitud no encontrada.', { chat_id: chatId, message_id: messageId });

      if (req.type === 'free') {
        await supabase
          .from('users')
          .update({ approved: true, membership: 'free' })
          .eq('id', req.user_id);

        await supabase
          .from('membership_requests')
          .update({ status: 'approved' })
          .eq('id', reqId);

        await bot.editMessageText(`Solicitud #${reqId} aprobada (gratis).`, { chat_id: chatId, message_id: messageId });
        await bot.sendMessage(req.user.telegram_id, '✅ ¡Felicidades! Tu solicitud básica ha sido aprobada. Ya puedes recibir señales.');
      } else {
        // Premium: marcar como pending_payment
        await supabase
          .from('membership_requests')
          .update({ status: 'pending_payment' })
          .eq('id', reqId);

        await bot.editMessageText(
          `Solicitud premium #${reqId} aprobada (Quotex verificado). El usuario debe continuar con el pago.`,
          { chat_id: chatId, message_id: messageId }
        );
        await bot.sendMessage(
          req.user.telegram_id,
          '✅ Tu registro en Quotex ha sido aprobado. Ahora, para completar el plan premium, '
          + 'debes realizar un depósito de 3000 CUP a la tarjeta **** **** **** 1234.\n'
          + 'Envía el número de teléfono desde el que harás la transferencia con /enviar_telefono <número>\n'
          + 'Luego envía la captura de la transferencia como foto.'
        );
      }
    }
    else if (data.startsWith('reject_') && isAdmin(telegramId)) {
      const reqId = parseInt(data.split('_')[1]);
      await setUserState(chatId, 'reject_reason', { reqId });
      await bot.editMessageText('Envía el motivo del rechazo:', { chat_id: chatId, message_id: messageId });
    }

    // ===== ADMIN: GESTIÓN DE SESIONES Y SEÑALES =====
    else if (data === 'admin_open_session' && isAdmin(telegramId)) {
      const { data: openSession } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'open')
        .maybeSingle();
      if (openSession) {
        return bot.editMessageText('Ya hay una sesión abierta.', { chat_id: chatId, message_id: messageId });
      }
      const now = getCubaNow();
      const { data: session, error } = await supabase
        .from('sessions')
        .insert([{ session_time: now.toISOString(), opened_at: now.toISOString(), status: 'open' }])
        .select()
        .single();
      if (error) throw error;
      await bot.editMessageText('Sesión abierta manualmente.', { chat_id: chatId, message_id: messageId });
      const { data: users } = await supabase.from('users').select('telegram_id').eq('approved', true);
      for (const u of users || []) {
        try { await bot.sendMessage(u.telegram_id, '🟢 Sesión de trading INICIADA'); } catch (e) { }
      }
    }
    else if (data === 'admin_close_session' && isAdmin(telegramId)) {
      const { data: session } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'open')
        .maybeSingle();
      if (!session) {
        return bot.editMessageText('No hay sesión abierta.', { chat_id: chatId, message_id: messageId });
      }
      const now = getCubaNow();
      await supabase
        .from('sessions')
        .update({ closed_at: now.toISOString(), status: 'closed' })
        .eq('id', session.id);
      await bot.editMessageText('Sesión cerrada.', { chat_id: chatId, message_id: messageId });
      const { data: users } = await supabase.from('users').select('telegram_id').eq('approved', true);
      for (const u of users || []) {
        try { await bot.sendMessage(u.telegram_id, '🔴 Sesión de trading FINALIZADA'); } catch (e) { }
      }
    }
    else if (data === 'admin_new_signal' && isAdmin(telegramId)) {
      const { data: session } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'open')
        .maybeSingle();
      if (!session) {
        return bot.editMessageText('No hay una sesión abierta. Abre una primero.', { chat_id: chatId, message_id: messageId });
      }
      await setUserState(chatId, 'signal_asset', { sessionId: session.id });
      await bot.editMessageText('Envía el activo (ej. EURUSD):', { chat_id: chatId, message_id: messageId });
    }
    else if (data.startsWith('tf_') && isAdmin(telegramId)) {
      const tf = data.split('_')[1];
      const state = await getUserState(chatId);
      if (!state || !state.data || !state.data.asset) return;
      await setUserState(chatId, 'signal_timeframe', { ...state.data, timeframe: tf });
      const keyboard = {
        inline_keyboard: [
          [{ text: '⬆️', callback_data: 'dir_up' }],
          [{ text: '⬇️', callback_data: 'dir_down' }],
        ],
      };
      await bot.editMessageText('Selecciona dirección:', { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
    }
    else if (data.startsWith('dir_') && isAdmin(telegramId)) {
      const direction = data === 'dir_up' ? 'up' : 'down';
      const state = await getUserState(chatId);
      if (!state || !state.data || !state.data.asset || !state.data.timeframe || !state.data.sessionId) return;

      const { asset, timeframe, sessionId } = state.data;
      const { data: lastSignal } = await supabase
        .from('signals')
        .select('signal_index')
        .eq('session_id', sessionId)
        .order('signal_index', { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextIndex = lastSignal ? lastSignal.signal_index + 1 : 1;

      const { data: signal, error } = await supabase
        .from('signals')
        .insert([{ session_id: sessionId, signal_index: nextIndex, asset, timeframe, direction }])
        .select()
        .single();
      if (error) throw error;

      // Obtener usuarios aprobados
      const { data: users } = await supabase.from('users').select('id, telegram_id, membership').eq('approved', true);
      const { data: sessionSignals } = await supabase.from('signals').select('id').eq('session_id', sessionId);
      const signalIds = sessionSignals.map(s => s.id);

      for (const user of users || []) {
        const { count } = await supabase
          .from('signal_deliveries')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('signal_id', signalIds);
        const maxAllowed = user.membership === 'premium' ? 10 : 5;
        if (count >= maxAllowed) continue;

        const emoji = direction === 'up' ? '⬆️' : '⬇️';
        const text = `📈 *Señal #${nextIndex}*\nActivo: ${asset}\nTiempo: ${timeframe}\nDirección: ${emoji}`;
        try {
          await bot.sendMessage(user.telegram_id, text, { parse_mode: 'Markdown' });
          await supabase.from('signal_deliveries').insert([{ signal_id: signal.id, user_id: user.id }]);
        } catch (e) { }
      }

      const keyboard = {
        inline_keyboard: [
          [{ text: 'Mantener activo', callback_data: 'keep_asset' }],
          [{ text: 'Nuevo activo', callback_data: 'new_asset' }],
        ],
      };
      await bot.editMessageText(`Señal #${nextIndex} enviada.\n¿Deseas mantener el activo ${asset}?`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
      });
    }
    else if (data === 'keep_asset' && isAdmin(telegramId)) {
      const state = await getUserState(chatId);
      if (!state || !state.data || !state.data.asset) return;
      await setUserState(chatId, 'signal_timeframe', { ...state.data });
      const keyboard = {
        inline_keyboard: [
          [{ text: '30s', callback_data: 'tf_30s' }],
          [{ text: '1M', callback_data: 'tf_1M' }],
          [{ text: '2M', callback_data: 'tf_2M' }],
          [{ text: '5M', callback_data: 'tf_5M' }],
        ],
      };
      await bot.editMessageText(`Activo: ${state.data.asset}\nSelecciona temporalidad:`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
      });
    }
    else if (data === 'new_asset' && isAdmin(telegramId)) {
      const state = await getUserState(chatId);
      if (!state || !state.data || !state.data.sessionId) return;
      await setUserState(chatId, 'signal_asset', { sessionId: state.data.sessionId });
      await bot.editMessageText('Envía el nuevo activo (ej. EURUSD):', {
        chat_id: chatId,
        message_id: messageId,
      });
    }
    else if (data.startsWith('result_') && isAdmin(telegramId)) {
      const parts = data.split('_');
      const signalId = parseInt(parts[1]);
      const result = parts[2];
      await supabase.from('signals').update({ result }).eq('id', signalId);
      await bot.editMessageText(`Resultado de señal #${signalId} guardado: ${result.toUpperCase()}`, {
        chat_id: chatId,
        message_id: messageId,
      });
    }
    else if (data === 'admin_pending_requests' && isAdmin(telegramId)) {
      const { data: reqs } = await supabase
        .from('membership_requests')
        .select('id, type, status, user:users(username, telegram_id)')
        .eq('status', 'pending');
      if (!reqs || reqs.length === 0) {
        return bot.editMessageText('No hay solicitudes pendientes.', { chat_id: chatId, message_id: messageId });
      }
      let texto = '📋 *Solicitudes pendientes:*\n';
      for (const r of reqs) {
        texto += `#${r.id} - ${r.type} - @${r.user.username || r.user.telegram_id} (${r.status})\n`;
      }
      await bot.editMessageText(texto, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
    }
    else if (data === 'admin_pending_results' && isAdmin(telegramId)) {
      const { data: signals } = await supabase
        .from('signals')
        .select('id, signal_index, asset, timeframe')
        .is('result', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (!signals || signals.length === 0) {
        return bot.editMessageText('No hay señales pendientes de resultado.', { chat_id: chatId, message_id: messageId });
      }
      for (const s of signals) {
        const keyboard = {
          inline_keyboard: [
            [
              { text: '✅ Profit', callback_data: `result_${s.id}_profit` },
              { text: '❌ Loss', callback_data: `result_${s.id}_loss` },
            ],
          ],
        };
        await bot.sendMessage(chatId, `Señal #${s.signal_index} - ${s.asset} ${s.timeframe}`, { reply_markup: keyboard });
      }
      await bot.deleteMessage(chatId, messageId);
    }

  } catch (error) {
    logger.error(`Error en callback: ${error.message}`);
    await bot.sendMessage(chatId, 'Ocurrió un error interno.');
  }
});

// ================== COMANDOS DE REGISTRO (ENVÍO DE TELÉFONO Y FOTO) ==================
bot.onText(/\/enviar_telefono (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const phone = match[1].trim();

  try {
    if (!/^[0-9]{8,12}$/.test(phone)) {
      return bot.sendMessage(chatId, '❌ Número de teléfono no válido. Debe tener 8-12 dígitos.');
    }
    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, 'Primero usa /planes.');
    const { data: req } = await supabase
      .from('membership_requests')
      .select('id')
      .eq('user_id', user.id)
      .eq('type', 'premium')
      .eq('status', 'pending_payment')
      .maybeSingle();
    if (!req) return bot.sendMessage(chatId, 'No tienes una solicitud premium pendiente de pago.');
    await supabase.from('membership_requests').update({ phone_number: phone }).eq('id', req.id);
    await bot.sendMessage(chatId, '✅ Número guardado. Ahora envía la captura de la transferencia como foto.');
  } catch (error) {
    logger.error(`Error en /enviar_telefono: ${error.message}`);
    await bot.sendMessage(chatId, 'Error al procesar.');
  }
});

// Manejador de fotos (captura de pago)
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const photo = msg.photo[msg.photo.length - 1];

  try {
    const user = await getUser(telegramId);
    if (!user) return;
    const { data: req } = await supabase
      .from('membership_requests')
      .select('id')
      .eq('user_id', user.id)
      .eq('type', 'premium')
      .eq('status', 'pending_payment')
      .maybeSingle();
    if (!req) return;

    const publicUrl = await uploadPhotoToSupabase(photo.file_id, user.id);
    await supabase
      .from('membership_requests')
      .update({ payment_screenshot_file_id: publicUrl })
      .eq('id', req.id);

    await bot.sendMessage(chatId, '✅ Captura recibida. Espera la confirmación del admin.');

    const { data: reqData } = await supabase
      .from('membership_requests')
      .select('phone_number')
      .eq('id', req.id)
      .single();

    for (const adminId of adminIds) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Aceptar pago', callback_data: `pay_accept_${req.id}` },
            { text: '❌ Rechazar pago', callback_data: `pay_reject_${req.id}` },
          ],
        ],
      };
      await bot.sendPhoto(
        adminId,
        publicUrl,
        {
          caption: `Pago de usuario @${msg.from.username || telegramId}\nTeléfono: ${reqData?.phone_number || 'No especificado'}\nSolicitud #${req.id}`,
          reply_markup: keyboard,
        }
      );
    }
  } catch (error) {
    logger.error(`Error en foto: ${error.message}`);
    await bot.sendMessage(chatId, 'Error al procesar la imagen. Intenta de nuevo.');
  }
});

// ================== TAREAS PROGRAMADAS (CRON) ==================
cron.schedule('*/1 * * * *', async () => {
  const now = getCubaNow();
  const hours = [10, 22];

  // Apertura automática
  for (const hour of hours) {
    const targetTime = new Date(now);
    targetTime.setHours(hour, 0, 0, 0);
    const diffMinutes = (now - targetTime) / 1000 / 60;
    if (diffMinutes >= 0 && diffMinutes <= 5) {
      const { data: openSession } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'open')
        .maybeSingle();
      if (openSession) continue;

      const targetISO = targetTime.toISOString();
      const { data: existing } = await supabase
        .from('sessions')
        .select('id')
        .eq('session_time', targetISO)
        .maybeSingle();
      if (existing) continue;

      const { data: session, error } = await supabase
        .from('sessions')
        .insert([{ session_time: targetISO, opened_at: now.toISOString(), status: 'open' }])
        .select()
        .single();
      if (!error) {
        const { data: users } = await supabase.from('users').select('telegram_id').eq('approved', true);
        for (const u of users || []) {
          try { await bot.sendMessage(u.telegram_id, '🟢 Sesión de trading INICIADA'); } catch (e) { }
        }
      }
    }
  }

  // Cierre automático después de 30 minutos
  const { data: openSessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('status', 'open');

  for (const sess of openSessions || []) {
    const opened = new Date(sess.opened_at);
    const diffMinutes = (now - opened) / 1000 / 60;
    if (diffMinutes >= 30) {
      await supabase
        .from('sessions')
        .update({ closed_at: now.toISOString(), status: 'closed' })
        .eq('id', sess.id);

      const { data: users } = await supabase.from('users').select('telegram_id').eq('approved', true);
      for (const u of users || []) {
        try { await bot.sendMessage(u.telegram_id, '🔴 Sesión de trading FINALIZADA'); } catch (e) { }
      }
    }
  }

  // Degradar premiums expirados
  const { data: expired } = await supabase
    .from('users')
    .select('id, telegram_id')
    .eq('membership', 'premium')
    .lt('premium_until', new Date().toISOString());

  for (const user of expired || []) {
    await supabase
      .from('users')
      .update({ membership: 'free', premium_until: null })
      .eq('id', user.id);
    try {
      await bot.sendMessage(
        user.telegram_id,
        '⏰ Tu membresía premium ha expirado. Ahora eres usuario básico. Renueva con /planes si lo deseas.'
      );
    } catch (e) { }
  }
}, { timezone: cubaTz });

// ================== PANEL WEB PARA ADMIN ==================
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

function checkAdmin(req, res, next) {
  const telegramId = parseInt(req.query.telegram_id);
  if (!telegramId || !adminIds.includes(telegramId)) {
    return res.status(403).send('Acceso denegado');
  }
  req.adminId = telegramId;
  next();
}

app.get('/admin', checkAdmin, async (req, res) => {
  try {
    const { data: requests, error } = await supabase
      .from('membership_requests')
      .select(`
        id, type, status, phone_number, payment_screenshot_file_id, created_at,
        user:users(telegram_id, username, quotex_id)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.render('admin', { requests, BASE_URL, adminId: req.adminId });
  } catch (error) {
    logger.error(`Error en panel admin: ${error.message}`);
    res.status(500).send('Error interno');
  }
});

app.post('/admin/process', checkAdmin, async (req, res) => {
  const { request_id, action, reason } = req.body;
  if (!request_id || !action) return res.status(400).send('Faltan datos');

  try {
    const { data: req, error } = await supabase
      .from('membership_requests')
      .select('*, user:users(*)')
      .eq('id', request_id)
      .single();
    if (error || !req) return res.status(404).send('Solicitud no encontrada');

    if (action === 'approve') {
      if (req.type === 'free') {
        await supabase
          .from('users')
          .update({ approved: true, membership: 'free' })
          .eq('id', req.user_id);
        await supabase
          .from('membership_requests')
          .update({ status: 'approved' })
          .eq('id', request_id);
        await bot.sendMessage(req.user.telegram_id, '✅ ¡Solicitud básica aprobada! Ya puedes recibir señales.');
      } else {
        // Premium: marcar como pending_payment (ya debería estar, pero si se aprueba desde panel, se puede manejar)
        // En este flujo, el panel solo debe usarse para aprobar/rechazar después del pago.
        // Por simplicidad, asumimos que si es premium y se aprueba, es porque ya pagó.
        const premiumUntil = new Date();
        premiumUntil.setDate(premiumUntil.getDate() + 30);
        await supabase
          .from('users')
          .update({ approved: true, membership: 'premium', premium_until: premiumUntil.toISOString() })
          .eq('id', req.user_id);
        await supabase
          .from('membership_requests')
          .update({ status: 'approved' })
          .eq('id', request_id);
        await bot.sendMessage(req.user.telegram_id, '✅ ¡Pago confirmado! Ahora eres usuario PREMIUM por 30 días.');
      }
    } else if (action === 'reject') {
      if (!reason) return res.status(400).send('Debe proporcionar un motivo');
      await supabase
        .from('membership_requests')
        .update({ status: 'rejected', rejection_reason: reason })
        .eq('id', request_id);
      await bot.sendMessage(req.user.telegram_id, `❌ Tu solicitud ha sido rechazada. Motivo: ${reason}`);
    }

    res.redirect(`/admin?telegram_id=${req.adminId}`);
  } catch (error) {
    logger.error(`Error procesando solicitud: ${error.message}`);
    res.status(500).send('Error interno');
  }
});

// Iniciar servidor web
app.listen(PORT, () => {
  logger.info(`Servidor web escuchando en puerto ${PORT}`);
});

logger.info('Bot iniciado correctamente');
