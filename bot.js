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

// Inicializar bot con polling
const bot = new TelegramBot(token, { polling: true });

// Inicializar Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

// Crear bucket si no existe
async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets.find(b => b.name === 'payment-screenshots')) {
    await supabase.storage.createBucket('payment-screenshots', { public: true });
    logger.info('✅ Bucket payment-screenshots creado');
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

// ================== MENÚ PRINCIPAL ==================
const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '📊 Planes' }, { text: '📈 Estadísticas' }],
      [{ text: '📜 Historial' }, { text: '❓ Ayuda' }],
      [{ text: '🔍 Buscar señal' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

const adminMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '📊 Planes' }, { text: '📈 Estadísticas' }],
      [{ text: '📜 Historial' }, { text: '❓ Ayuda' }],
      [{ text: '🔧 Panel Admin' }, { text: '🔍 Buscar señal' }]
    ],
    resize_keyboard: true
  }
};

// ================== ESTADOS PERSISTENTES EN SUPABASE ==================
async function setUserState(chatId, step, data = {}) {
  logger.info(`setUserState: chatId=${chatId}, step=${step}, data=${JSON.stringify(data)}`);
  const { error } = await supabase
    .from('admin_states')
    .upsert({ chat_id: chatId, step, data }, { onConflict: 'chat_id' });
  if (error) {
    logger.error(`Error en setUserState: ${error.message}`);
    throw error;
  }
}

async function getUserState(chatId) {
  logger.info(`getUserState: chatId=${chatId}`);
  const { data, error } = await supabase
    .from('admin_states')
    .select('step, data')
    .eq('chat_id', chatId)
    .maybeSingle();
  if (error) {
    logger.error(`Error en getUserState: ${error.message}`);
    throw error;
  }
  logger.info(`getUserState result: ${JSON.stringify(data)}`);
  return data;
}

async function clearUserState(chatId) {
  logger.info(`clearUserState: chatId=${chatId}`);
  const { error } = await supabase
    .from('admin_states')
    .delete()
    .eq('chat_id', chatId);
  if (error) {
    logger.error(`Error en clearUserState: ${error.message}`);
    throw error;
  }
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
Responde siempre con emojis y formato amigable.
Temas: análisis técnico, fundamental, gestión de riesgo, psicología, estrategias.
Nunca des consejos de inversión personalizados.
Si el usuario comparte una noticia, analiza su posible impacto en el mercado.`
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
        model: 'mistralai/mistral-7b-instruct',
        messages,
        max_tokens: 700,
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
    const welcomeText = 
      '🚀 <b>¡Bienvenido al Bot de Señales de Trading!</b>\n\n'
      + '📊 <b>¿Qué ofrecemos?</b>\n'
      + '• Señales de trading en vivo para opciones binarias.\n'
      + '• Dos sesiones diarias (10:00 AM y 10:00 PM hora Cuba).\n'
      + '• Estadísticas y historial de señales.\n'
      + '• Asistente IA para consultas (solo premium).\n\n'
      + '🎯 <b>Planes:</b>\n'
      + '🆓 <b>Básico (gratis):</b> 5 señales por sesión, estadísticas desde tu registro.\n'
      + '⭐ <b>Premium (3000 CUP/mes):</b> 10 señales por sesión, estadísticas completas, acceso a IA, búsqueda de señales.\n\n'
      + 'Para contratar, usa el botón 📊 Planes del menú.';
    await bot.sendMessage(
      chatId,
      welcomeText,
      { ...keyboard, parse_mode: 'HTML' }
    );
  } catch (error) {
    logger.error(`Error en /start: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error. Intenta más tarde.');
  }
});

// ================== MANEJADOR DE MENSAJES DE TEXTO ==================
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text;
  const telegramId = msg.from.id;
  const username = msg.from.username;

  try {
    // Verificar si hay estado pendiente (esto debe ir primero)
    const state = await getUserState(chatId);
    logger.info(`Mensaje de ${telegramId}: "${text}" - Estado: ${JSON.stringify(state)}`);

    if (state) {
      // Procesar según el paso
      if (state.step === 'awaiting_quotex_free' || state.step === 'awaiting_quotex_premium') {
        await handleQuotexResponse(chatId, telegramId, username, text, state.step);
        return;
      } else if (state.step === 'awaiting_phone') {
        await handlePhoneResponse(chatId, telegramId, text, state.data);
        return;
      } else if (state.step === 'reject_reason') {
        await handleRejectReason(chatId, telegramId, text, state.data);
        return;
      } else if (state.step === 'signal_asset') {
        await handleSignalAsset(chatId, telegramId, text, state.data);
        return;
      } else if (state.step === 'search_signal') {
        await handleSearchSignal(chatId, telegramId, text);
        return;
      }
      // Si el estado no es ninguno de estos, lo limpiamos
      await clearUserState(chatId);
    }

    // Si no hay estado, procesamos opciones del menú
    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, '❌ Usa /start primero.');

    if (text === '📊 Planes') {
      const keyboard = {
        inline_keyboard: [
          [{ text: '🆓 Plan Básico (gratis)', callback_data: 'plan_free' }],
          [{ text: '⭐ Plan Premium (3000 CUP/mes)', callback_data: 'plan_premium' }],
        ],
      };
      await bot.sendMessage(chatId, '📋 <b>Elige un plan:</b>', { reply_markup: keyboard, parse_mode: 'HTML' });
    }
    else if (text === '📈 Estadísticas') {
      await handleEstadisticas(chatId, user);
    }
    else if (text === '📜 Historial') {
      await handleHistorial(chatId, user);
    }
    else if (text === '🔍 Buscar señal') {
      if (user.membership !== 'premium') {
        return bot.sendMessage(chatId, '❌ Esta función es solo para usuarios premium.');
      }
      await setUserState(chatId, 'search_signal', {});
      await bot.sendMessage(chatId, '🔍 <b>Ingresa el ID de la señal que deseas buscar:</b>', { parse_mode: 'HTML' });
    }
    else if (text === '❓ Ayuda') {
      await bot.sendMessage(chatId, 
        '❓ <b>Ayuda</b>\n\n'
        + '📊 Planes: Ver y contratar membresías.\n'
        + '📈 Estadísticas: Rendimiento según tu plan.\n'
        + '📜 Historial: Últimas señales recibidas.\n'
        + '🔍 Buscar señal: Premium - consulta detalles de una señal por ID.\n'
        + '🔧 Panel Admin: Solo para administradores.\n\n'
        + 'Para más información, contacta al admin.',
        { parse_mode: 'HTML' }
      );
    }
    else if (text === '🔧 Panel Admin' && isAdmin(telegramId)) {
      const keyboard = {
        inline_keyboard: [
          [{ text: '🟢 Abrir sesión manual', callback_data: 'admin_open_session' }],
          [{ text: '🔴 Cerrar sesión', callback_data: 'admin_close_session' }],
          [{ text: '🆕 Nueva señal', callback_data: 'admin_new_signal' }],
          [{ text: '📋 Solicitudes pendientes', callback_data: 'admin_pending_requests' }],
          [{ text: '🎯 Resultados pendientes', callback_data: 'admin_pending_results' }],
          [{ text: '🌐 Panel web', url: `${BASE_URL}/admin?telegram_id=${telegramId}` }]
        ],
      };
      await bot.sendMessage(chatId, '🔧 <b>Panel de Administración:</b>', { reply_markup: keyboard, parse_mode: 'HTML' });
    }
  } catch (error) {
    logger.error(`Error en message handler: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Error interno.');
  }
});

// ================== FUNCIONES AUXILIARES ==================
async function hasActiveRequest(userId) {
  const { data, error } = await supabase
    .from('membership_requests')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['pending', 'pending_payment'])
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

async function handleQuotexResponse(chatId, telegramId, username, quotexId, step) {
  if (!isValidQuotexId(quotexId)) {
    return bot.sendMessage(chatId, '❌ <b>ID de Quotex no válido.</b>\nDebe tener entre 6 y 20 caracteres alfanuméricos.', { parse_mode: 'HTML' });
  }

  const user = await getUser(telegramId);
  if (!user) return bot.sendMessage(chatId, '❌ Error: usuario no encontrado.');

  // Verificar si ya tiene una solicitud activa
  if (await hasActiveRequest(user.id)) {
    return bot.sendMessage(chatId, '⚠️ Ya tienes una solicitud pendiente. Espera a que sea procesada antes de crear otra.', { parse_mode: 'HTML' });
  }

  await supabase.from('users').update({ quotex_id: quotexId }).eq('id', user.id);

  const status = (step === 'awaiting_quotex_free') ? 'pending' : 'pending_payment';

  const { data: req, error } = await supabase
    .from('membership_requests')
    .insert([{
      user_id: user.id,
      type: step === 'awaiting_quotex_free' ? 'free' : 'premium',
      status: status
    }])
    .select()
    .single();

  if (error) throw error;

  await bot.sendMessage(chatId, '✅ <b>ID recibido.</b>\n' + 
    (step === 'awaiting_quotex_free' 
      ? 'Tu solicitud ha sido enviada al admin. Espera la confirmación.' 
      : 'Ahora sigue los pasos para completar el pago.'), 
    { parse_mode: 'HTML' });

  if (step === 'awaiting_quotex_premium') {
    // Instrucciones de pago detalladas
    await bot.sendMessage(chatId,
      '💰 <b>Instrucciones para el pago premium:</b>\n\n'
      + '1. Realiza una transferencia de <b>3000 CUP</b> a la siguiente tarjeta:\n'
      + '<code>**** **** **** 1234</code>\n'
      + '2. En Transfermóvil, <b>activa la casilla "Mostrar número al destinatario"</b> para que podamos verificar tu pago.\n'
      + '3. Luego, presiona el botón "📞 Enviar número" y escribe el número de teléfono desde el cual realizaste la transferencia.\n\n'
      + '⬇️ Presiona el botón para continuar.',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📞 Enviar número', callback_data: 'send_phone' }]] } }
    );
    // Guardamos el request_id en el estado para asociarlo luego
    await setUserState(chatId, 'awaiting_phone_init', { requestId: req.id });
  } else {
    // Free: notificar al admin
    await notifyAdminNewRequest(req.id, username, telegramId, quotexId, req.type);
  }

  await clearUserState(chatId); // limpiamos el estado anterior
}

async function handlePhoneResponse(chatId, telegramId, phone, data) {
  const requestId = data.requestId;
  if (!/^[0-9]{8,12}$/.test(phone)) {
    return bot.sendMessage(chatId, '❌ <b>Número no válido.</b> Debe tener 8-12 dígitos.', { parse_mode: 'HTML' });
  }

  await supabase
    .from('membership_requests')
    .update({ phone_number: phone })
    .eq('id', requestId);

  await bot.sendMessage(chatId, '✅ <b>Número guardado.</b>\nAhora envía la captura de la transferencia como foto.', { parse_mode: 'HTML' });
  await setUserState(chatId, 'awaiting_screenshot', { requestId });
}

async function handleRejectReason(chatId, telegramId, reason, data) {
  const reqId = data.reqId;
  await clearUserState(chatId);

  try {
    const { data: req } = await supabase
      .from('membership_requests')
      .select('user:users(telegram_id)')
      .eq('id', reqId)
      .single();

    await supabase
      .from('membership_requests')
      .update({ status: 'rejected', rejection_reason: reason })
      .eq('id', reqId);

    if (req) {
      await bot.sendMessage(req.user.telegram_id, `❌ <b>Tu solicitud ha sido rechazada.</b>\nMotivo: ${reason}`, { parse_mode: 'HTML' });
    }
    await bot.sendMessage(chatId, `✅ Rechazo notificado para solicitud #${reqId}.`);
  } catch (err) {
    logger.error(`Error en rechazo: ${err.message}`);
    await bot.sendMessage(chatId, '❌ Error al procesar rechazo.');
  }
}

async function handleSignalAsset(chatId, telegramId, asset, data) {
  if (!asset || asset.length < 2) {
    return bot.sendMessage(chatId, '❌ Activo no válido. Intenta de nuevo.');
  }
  // Guardamos el nuevo estado con el activo en mayúsculas
  await setUserState(chatId, 'signal_timeframe', { ...data, asset: asset.toUpperCase() });
  const keyboard = {
    inline_keyboard: [
      [{ text: '⏱️ 30s', callback_data: 'tf_30s' }, { text: '⏱️ 1M', callback_data: 'tf_1M' }],
      [{ text: '⏱️ 2M', callback_data: 'tf_2M' }, { text: '⏱️ 5M', callback_data: 'tf_5M' }],
    ],
  };
  await bot.sendMessage(chatId, '📊 <b>Selecciona temporalidad:</b>', { reply_markup: keyboard, parse_mode: 'HTML' });
}

async function handleSearchSignal(chatId, telegramId, text) {
  const signalId = parseInt(text);
  if (isNaN(signalId) || signalId < 1) {
    return bot.sendMessage(chatId, '❌ ID no válido. Debe ser un número entero positivo.', { parse_mode: 'HTML' });
  }
  const { data: signal, error } = await supabase
    .from('signals')
    .select('*')
    .eq('id', signalId)
    .single();
  if (error || !signal) {
    return bot.sendMessage(chatId, '❌ No se encontró ninguna señal con ese ID.', { parse_mode: 'HTML' });
  }
  const emoji = signal.direction === 'up' ? '⬆️' : '⬇️';
  const resultText = signal.result ? (signal.result === 'profit' ? '✅ Profit' : '❌ Loss') : '⏳ Pendiente';
  const textResponse = `📈 <b>Señal #${signal.id}</b>\n`
    + `💰 Activo: ${signal.asset}\n`
    + `⏱️ Tiempo: ${signal.timeframe}\n`
    + `📊 Dirección: ${emoji}\n`
    + `📌 Resultado: ${resultText}`;
  await bot.sendMessage(chatId, textResponse, { parse_mode: 'HTML' });
  await clearUserState(chatId);
}

async function handleEstadisticas(chatId, user) {
  let query = supabase.from('signals').select('*');
  if (user.membership === 'free') {
    query = query.gte('created_at', user.created_at);
  }
  const { data: signals, error } = await query;
  if (error) throw error;

  const total = signals.length;
  if (total === 0) {
    return bot.sendMessage(chatId, '📊 <b>No hay suficientes datos aún.</b>', { parse_mode: 'HTML' });
  }

  const profits = signals.filter(s => s.result === 'profit').length;
  const losses = signals.filter(s => s.result === 'loss').length;
  const winrate = total > 0 ? ((profits / total) * 100).toFixed(2) : 0;

  let texto = `📊 <b>Estadísticas ${user.membership === 'premium' ? '⭐ PREMIUM' : '🆓 BÁSICAS'}</b>\n\n`;
  texto += `📈 Señales totales: ${total}\n`;
  texto += `✅ Profit: ${profits}\n`;
  texto += `❌ Loss: ${losses}\n`;
  texto += `📊 Winrate: ${winrate}%\n`;
  texto += `⏳ Pendientes: ${total - profits - losses}`;

  await bot.sendMessage(chatId, texto, { parse_mode: 'HTML' });
}

async function handleHistorial(chatId, user) {
  const { data: deliveries, error } = await supabase
    .from('signal_deliveries')
    .select(`
      signal:signals!inner(id, signal_index, asset, timeframe, direction, result)
    `)
    .eq('user_id', user.id)
    .order('delivered_at', { ascending: false })
    .limit(10);

  if (error) throw error;
  if (!deliveries.length) {
    return bot.sendMessage(chatId, '📭 <b>Aún no has recibido señales.</b>', { parse_mode: 'HTML' });
  }

  const lines = deliveries.map(d => {
    const s = d.signal;
    const emoji = s.direction === 'up' ? '⬆️' : '⬇️';
    const result = s.result ? (s.result === 'profit' ? '✅' : '❌') : '⏳';
    return `#${s.id} ${s.asset} ${s.timeframe} ${emoji} ${result}`;
  });
  await bot.sendMessage(chatId, '📜 <b>Últimas señales:</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
}

async function notifyAdminNewRequest(requestId, username, telegramId, quotexId, type) {
  for (const adminId of adminIds) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Aprobar', callback_data: `approve_${requestId}` },
          { text: '❌ Rechazar', callback_data: `reject_${requestId}` }
        ],
        [{ text: '🌐 Ir al Panel Web', url: `${BASE_URL}/admin?telegram_id=${adminId}` }]
      ]
    };
    await bot.sendMessage(
      adminId,
      `📨 <b>Nueva solicitud de membresía</b>\n\n`
      + `👤 Usuario: ${username ? '@' + username : telegramId}\n`
      + `🆔 ID Telegram: <code>${telegramId}</code>\n`
      + `📋 Tipo: ${type === 'free' ? '🆓 Básico' : '⭐ Premium'}\n`
      + `🔑 ID Quotex: <code>${quotexId}</code>\n`
      + `📌 Estado: Pendiente de aprobación`,
      { reply_markup: keyboard, parse_mode: 'HTML' }
    );
  }
}

// ================== MANEJADOR DE CALLBACKS ==================
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = msg.chat.id;
  const telegramId = callbackQuery.from.id;
  const messageId = msg.message_id;
  const username = callbackQuery.from.username;

  await bot.answerCallbackQuery(callbackQuery.id);

  try {
    const user = await getOrCreateUser(telegramId, username);
    logger.info(`Callback: data=${data}, chatId=${chatId}, telegramId=${telegramId}`);

    // ===== PLANES =====
    if (data === 'plan_free') {
      if (await hasActiveRequest(user.id)) {
        return bot.editMessageText('⚠️ Ya tienes una solicitud pendiente. Espera a que sea procesada.', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      }
      await bot.editMessageText(
        '🆓 <b>Plan Básico (Gratis)</b>\n\n'
        + '📌 <b>Requisitos:</b>\n'
        + '1. Regístrate en Quotex con este enlace: [ENLACE_QUOTEX]\n'
        + '2. La cuenta debe ser <b>totalmente nueva</b>.\n'
        + '3. Completa la verificación KYC.\n'
        + '4. Realiza un depósito mínimo de <b>10 USDT</b> en tu cuenta Quotex.\n\n'
        + '📤 <i>Luego de registrarte, responde a este mensaje con tu ID de Quotex.</i>',
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
      );
      await setUserState(chatId, 'awaiting_quotex_free', { userId: user.id });
    }
    else if (data === 'plan_premium') {
      if (await hasActiveRequest(user.id)) {
        return bot.editMessageText('⚠️ Ya tienes una solicitud pendiente. Espera a que sea procesada.', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      }
      await bot.editMessageText(
        '⭐ <b>Plan Premium (3000 CUP/mes)</b>\n\n'
        + '📌 <b>Requisitos:</b>\n'
        + '1. Regístrate en Quotex con este enlace: [ENLACE_QUOTEX]\n'
        + '2. Cuenta <b>nueva</b> y verificación KYC.\n'
        + '3. Depósito mínimo de <b>10 USDT</b> en Quotex.\n\n'
        + '💰 <b>Pago de membresía:</b> 3000 CUP\n'
        + '4. Después de enviar tu ID de Quotex, recibirás las instrucciones para realizar el pago.\n\n'
        + '📤 <i>Responde a este mensaje con tu ID de Quotex para comenzar.</i>',
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
      );
      await setUserState(chatId, 'awaiting_quotex_premium', { userId: user.id });
    }
    else if (data === 'send_phone') {
      const state = await getUserState(chatId);
      if (!state || state.step !== 'awaiting_phone_init') return;
      await setUserState(chatId, 'awaiting_phone', { requestId: state.data.requestId });
      await bot.editMessageText(
        '📞 <b>Envía el número de teléfono</b> desde el cual realizaste la transferencia (solo dígitos):',
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
      );
    }

    // ===== ADMIN: APROBAR/RECHAZAR (solo free) =====
    else if (data.startsWith('approve_') && isAdmin(telegramId)) {
      const reqId = parseInt(data.split('_')[1]);
      const { data: req, error } = await supabase
        .from('membership_requests')
        .select('*, user:users(*)')
        .eq('id', reqId)
        .single();

      if (error || !req) return bot.editMessageText('❌ Solicitud no encontrada.', { chat_id: chatId, message_id: messageId });

      if (req.type === 'free') {
        await supabase
          .from('users')
          .update({ approved: true, membership: 'free' })
          .eq('id', req.user_id);
        await supabase
          .from('membership_requests')
          .update({ status: 'approved' })
          .eq('id', reqId);
        await bot.editMessageText(`✅ Solicitud #${reqId} aprobada (gratis).`, { chat_id: chatId, message_id: messageId });
        await bot.sendMessage(req.user.telegram_id, '✅ <b>¡Felicidades!</b> Tu solicitud básica ha sido aprobada. Ya puedes recibir señales.', { parse_mode: 'HTML' });
      } else {
        await bot.editMessageText('⚠️ Para aprobar un premium, usa el botón de pago.', { chat_id: chatId, message_id: messageId });
      }
    }
    else if (data.startsWith('reject_') && isAdmin(telegramId)) {
      const reqId = parseInt(data.split('_')[1]);
      await setUserState(chatId, 'reject_reason', { reqId });
      await bot.editMessageText('✏️ <b>Envía el motivo del rechazo:</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    }

    // ===== ADMIN: PAGOS =====
    else if (data.startsWith('pay_accept_') && isAdmin(telegramId)) {
      const reqId = parseInt(data.split('_')[2]);
      const { data: req } = await supabase
        .from('membership_requests')
        .select('*, user:users(*)')
        .eq('id', reqId)
        .single();
      if (!req) return;
      const premiumUntil = new Date();
      premiumUntil.setDate(premiumUntil.getDate() + 30);
      await supabase
        .from('users')
        .update({ approved: true, membership: 'premium', premium_until: premiumUntil.toISOString() })
        .eq('id', req.user_id);
      await supabase
        .from('membership_requests')
        .update({ status: 'approved' })
        .eq('id', reqId);
      await bot.editMessageText(`✅ Pago aceptado. Usuario premium hasta ${premiumUntil.toLocaleDateString()}.`, { chat_id: chatId, message_id: messageId });
      await bot.sendMessage(req.user.telegram_id, '✅ <b>¡Pago confirmado!</b>\nAhora eres usuario PREMIUM por 30 días. Disfruta de todas las señales y la IA.', { parse_mode: 'HTML' });
    }
    else if (data.startsWith('pay_reject_') && isAdmin(telegramId)) {
      const reqId = parseInt(data.split('_')[2]);
      await setUserState(chatId, 'reject_reason', { reqId });
      await bot.editMessageText('✏️ <b>Envía el motivo del rechazo del pago:</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    }

    // ===== ADMIN: GESTIÓN DE SESIONES Y SEÑALES =====
    else if (data === 'admin_open_session' && isAdmin(telegramId)) {
      const { data: openSession } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'open')
        .maybeSingle();
      if (openSession) {
        return bot.editMessageText('⚠️ Ya hay una sesión abierta.', { chat_id: chatId, message_id: messageId });
      }
      const now = getCubaNow();
      const { data: session, error } = await supabase
        .from('sessions')
        .insert([{ session_time: now.toISOString(), opened_at: now.toISOString(), status: 'open' }])
        .select()
        .single();
      if (error) throw error;
      await bot.editMessageText('🟢 Sesión abierta manualmente.', { chat_id: chatId, message_id: messageId });
      const { data: users } = await supabase.from('users').select('telegram_id').eq('approved', true);
      for (const u of users || []) {
        try { await bot.sendMessage(u.telegram_id, '🟢 <b>Sesión de trading INICIADA</b>', { parse_mode: 'HTML' }); } catch (e) { }
      }
    }
    else if (data === 'admin_close_session' && isAdmin(telegramId)) {
      const { data: session } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'open')
        .maybeSingle();
      if (!session) {
        return bot.editMessageText('⚠️ No hay sesión abierta.', { chat_id: chatId, message_id: messageId });
      }
      const now = getCubaNow();
      await supabase
        .from('sessions')
        .update({ closed_at: now.toISOString(), status: 'closed' })
        .eq('id', session.id);
      await bot.editMessageText('🔴 Sesión cerrada.', { chat_id: chatId, message_id: messageId });
      const { data: users } = await supabase.from('users').select('telegram_id').eq('approved', true);
      for (const u of users || []) {
        try { await bot.sendMessage(u.telegram_id, '🔴 <b>Sesión de trading FINALIZADA</b>', { parse_mode: 'HTML' }); } catch (e) { }
      }
    }
    else if (data === 'admin_new_signal' && isAdmin(telegramId)) {
      const { data: session } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'open')
        .maybeSingle();
      if (!session) {
        return bot.editMessageText('⚠️ No hay una sesión abierta. Abre una primero.', { chat_id: chatId, message_id: messageId });
      }
      await setUserState(chatId, 'signal_asset', { sessionId: session.id });
      await bot.editMessageText('✏️ <b>Envía el activo (ej. EURUSD):</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    }
    else if (data.startsWith('tf_') && isAdmin(telegramId)) {
      const tf = data.split('_')[1];
      const state = await getUserState(chatId);
      if (!state || !state.data || !state.data.asset) return;
      await setUserState(chatId, 'signal_direction', { ...state.data, timeframe: tf });
      const keyboard = {
        inline_keyboard: [
          [{ text: '⬆️ Arriba', callback_data: 'dir_up' }],
          [{ text: '⬇️ Abajo', callback_data: 'dir_down' }],
        ],
      };
      await bot.editMessageText('📊 <b>Selecciona dirección:</b>', { chat_id: chatId, message_id: messageId, reply_markup: keyboard, parse_mode: 'HTML' });
    }
    else if (data.startsWith('dir_') && isAdmin(telegramId)) {
      const direction = data === 'dir_up' ? 'up' : 'down';
      const state = await getUserState(chatId);
      if (!state || !state.data || !state.data.asset || !state.data.timeframe || !state.data.sessionId) return;

      const { asset, timeframe, sessionId } = state.data;
      
      // Obtener el último ID de señal global
      const { data: lastSignal } = await supabase
        .from('signals')
        .select('id')
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextId = lastSignal ? lastSignal.id + 1 : 1;

      const { data: signal, error } = await supabase
        .from('signals')
        .insert([{ 
          id: nextId,
          session_id: sessionId, 
          signal_index: nextId, 
          asset, 
          timeframe, 
          direction 
        }])
        .select()
        .single();
      if (error) throw error;

      // Obtener usuarios aprobados
      const { data: users } = await supabase.from('users').select('id, telegram_id, membership').eq('approved', true);
      
      // Obtener señales de esta sesión para contar entregas
      const { data: sessionSignals } = await supabase
        .from('signals')
        .select('id')
        .eq('session_id', sessionId);
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
        const text = `📈 <b>Señal #${signal.id}</b>\n`
                   + `💰 Activo: ${asset}\n`
                   + `⏱️ Tiempo: ${timeframe}\n`
                   + `📊 Dirección: ${emoji}\n`
                   + `📌 Resultado: ⏳ Pendiente`;
        try {
          await bot.sendMessage(user.telegram_id, text, { parse_mode: 'HTML' });
          await supabase.from('signal_deliveries').insert([{ signal_id: signal.id, user_id: user.id }]);
        } catch (e) { }
      }

      const keyboard = {
        inline_keyboard: [
          [{ text: '🔄 Mantener activo', callback_data: 'keep_asset' }],
          [{ text: '🆕 Nuevo activo', callback_data: 'new_asset' }],
        ],
      };
      await bot.editMessageText(`✅ <b>Señal #${signal.id} enviada.</b>\n¿Deseas mantener el activo ${asset}?`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'HTML'
      });
      await clearUserState(chatId);
    }
    else if (data === 'keep_asset' && isAdmin(telegramId)) {
      const state = await getUserState(chatId);
      if (!state || !state.data || !state.data.asset) return;
      // Para mantener el activo, pasamos a seleccionar tiempo nuevamente
      await setUserState(chatId, 'signal_timeframe', { ...state.data, asset: state.data.asset });
      const keyboard = {
        inline_keyboard: [
          [{ text: '⏱️ 30s', callback_data: 'tf_30s' }, { text: '⏱️ 1M', callback_data: 'tf_1M' }],
          [{ text: '⏱️ 2M', callback_data: 'tf_2M' }, { text: '⏱️ 5M', callback_data: 'tf_5M' }],
        ],
      };
      await bot.editMessageText(`🔄 <b>Manteniendo activo:</b> ${state.data.asset}\nSelecciona temporalidad:`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'HTML'
      });
    }
    else if (data === 'new_asset' && isAdmin(telegramId)) {
      const state = await getUserState(chatId);
      if (!state || !state.data || !state.data.sessionId) return;
      await setUserState(chatId, 'signal_asset', { sessionId: state.data.sessionId });
      await bot.editMessageText('✏️ <b>Envía el nuevo activo (ej. EURUSD):</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    }
    else if (data.startsWith('result_') && isAdmin(telegramId)) {
      const parts = data.split('_');
      const signalId = parseInt(parts[1]);
      const result = parts[2];
      await supabase.from('signals').update({ result }).eq('id', signalId);
      await bot.editMessageText(`✅ Resultado de señal #${signalId} guardado: ${result === 'profit' ? '✅ Profit' : '❌ Loss'}`, { chat_id: chatId, message_id: messageId });
    }
    else if (data === 'admin_pending_requests' && isAdmin(telegramId)) {
      const { data: reqs } = await supabase
        .from('membership_requests')
        .select('id, type, status, user:users(username, telegram_id)')
        .eq('status', 'pending');
      if (!reqs || reqs.length === 0) {
        return bot.editMessageText('📭 No hay solicitudes pendientes.', { chat_id: chatId, message_id: messageId });
      }
      let texto = '📋 <b>Solicitudes pendientes:</b>\n';
      for (const r of reqs) {
        texto += `#${r.id} - ${r.type === 'free' ? '🆓' : '⭐'} - @${r.user.username || r.user.telegram_id}\n`;
      }
      await bot.editMessageText(texto, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    }
    else if (data === 'admin_pending_results' && isAdmin(telegramId)) {
      const { data: signals } = await supabase
        .from('signals')
        .select('id, asset, timeframe, direction')
        .is('result', null)
        .order('id', { ascending: false })
        .limit(20);
      if (!signals || signals.length === 0) {
        return bot.editMessageText('🎯 No hay señales pendientes de resultado.', { chat_id: chatId, message_id: messageId });
      }
      // Mostrar lista
      let list = '🎯 <b>Señales pendientes (últimas 20):</b>\n';
      for (const s of signals) {
        list += `#${s.id} - ${s.asset} ${s.timeframe} ${s.direction === 'up' ? '⬆️' : '⬇️'}\n`;
      }
      await bot.sendMessage(chatId, list, { parse_mode: 'HTML' });
      // Instrucción para marcar resultado
      await bot.sendMessage(chatId, 'Para marcar resultado, usa el comando:\n<code>/resultado &lt;ID&gt; profit/loss</code>\n\nEjemplo: /resultado 161 profit', { parse_mode: 'HTML' });
    }

  } catch (error) {
    logger.error(`Error en callback: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error interno.');
  }
});

// ================== COMANDO PARA RESULTADOS (ADMIN) ==================
bot.onText(/\/resultado (\d+) (profit|loss)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  if (!isAdmin(telegramId)) return;
  const signalId = parseInt(match[1]);
  const result = match[2];
  try {
    const { data: signal, error } = await supabase
      .from('signals')
      .update({ result })
      .eq('id', signalId)
      .select()
      .single();
    if (error) throw error;
    await bot.sendMessage(chatId, `✅ Resultado de señal #${signalId} guardado: ${result === 'profit' ? '✅ Profit' : '❌ Loss'}`);
  } catch (err) {
    logger.error(`Error en /resultado: ${err.message}`);
    await bot.sendMessage(chatId, '❌ Error al guardar resultado. Verifica que el ID exista.');
  }
});

// ================== MANEJADOR DE FOTOS ==================
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const photo = msg.photo[msg.photo.length - 1];

  try {
    const state = await getUserState(chatId);
    if (!state || state.step !== 'awaiting_screenshot') return;

    const user = await getUser(telegramId);
    if (!user) return;

    const publicUrl = await uploadPhotoToSupabase(photo.file_id, user.id);
    await supabase
      .from('membership_requests')
      .update({ payment_screenshot_file_id: publicUrl })
      .eq('id', state.data.requestId);

    await bot.sendMessage(chatId, '✅ <b>Captura recibida.</b>\nEspera la confirmación del admin.', { parse_mode: 'HTML' });
    await clearUserState(chatId);

    // Obtener datos de la solicitud
    const { data: req } = await supabase
      .from('membership_requests')
      .select('*, user:users(*)')
      .eq('id', state.data.requestId)
      .single();

    // Notificar a los admins con botones de pago
    for (const adminId of adminIds) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Aceptar pago', callback_data: `pay_accept_${req.id}` },
            { text: '❌ Rechazar pago', callback_data: `pay_reject_${req.id}` }
          ],
        ],
      };
      await bot.sendPhoto(
        adminId,
        publicUrl,
        {
          caption: `📸 <b>Nuevo pago recibido</b>\n\n👤 Usuario: @${msg.from.username || telegramId}\n📞 Teléfono: ${req.phone_number || 'No especificado'}\n🆔 Solicitud #${req.id}\n⭐ Plan Premium`,
          reply_markup: keyboard,
          parse_mode: 'HTML'
        }
      );
    }
  } catch (error) {
    logger.error(`Error en foto: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Error al procesar la imagen. Intenta de nuevo.');
  }
});

// ================== IA PARA PREMIUM ==================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const text = msg.text;

  if (isAdmin(telegramId)) return; // los admins no usan IA aquí

  try {
    const user = await getUser(telegramId);
    if (!user || !user.approved || user.membership !== 'premium') return;

    // Verificar horario de trading (no responder durante sesiones)
    const now = getCubaNow();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const isTradingTime = (hour === 10 && minute < 30) || (hour === 22 && minute < 30);
    if (isTradingTime) {
      return bot.sendMessage(chatId, '⏳ <b>Estamos en horario de trading.</b> Vuelve después de la sesión.', { parse_mode: 'HTML' });
    }

    const reply = await askIA(user.id, text);
    await bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });

  } catch (error) {
    logger.error(`Error en IA usuario: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Lo siento, ahora no puedo procesar tu consulta.');
  }
});

// ================== TAREAS PROGRAMADAS ==================
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
          try { await bot.sendMessage(u.telegram_id, '🟢 <b>Sesión de trading INICIADA</b>', { parse_mode: 'HTML' }); } catch (e) { }
        }
      }
    }
  }

  // Cierre automático
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
        try { await bot.sendMessage(u.telegram_id, '🔴 <b>Sesión de trading FINALIZADA</b>', { parse_mode: 'HTML' }); } catch (e) { }
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
        '⏰ <b>Tu membresía premium ha expirado.</b>\nAhora eres usuario básico. Renueva con /planes si lo deseas.',
        { parse_mode: 'HTML' }
      );
    } catch (e) { }
  }
}, { timezone: cubaTz });

// ================== PANEL WEB ==================
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
    const { data: reqData, error } = await supabase
      .from('membership_requests')
      .select('*, user:users(*)')
      .eq('id', request_id)
      .single();
    if (error || !reqData) return res.status(404).send('Solicitud no encontrada');

    if (action === 'approve') {
      if (reqData.type === 'free') {
        await supabase
          .from('users')
          .update({ approved: true, membership: 'free' })
          .eq('id', reqData.user_id);
        await supabase
          .from('membership_requests')
          .update({ status: 'approved' })
          .eq('id', request_id);
        await bot.sendMessage(reqData.user.telegram_id, '✅ <b>¡Solicitud básica aprobada!</b>\nYa puedes recibir señales.', { parse_mode: 'HTML' });
      } else {
        const premiumUntil = new Date();
        premiumUntil.setDate(premiumUntil.getDate() + 30);
        await supabase
          .from('users')
          .update({ approved: true, membership: 'premium', premium_until: premiumUntil.toISOString() })
          .eq('id', reqData.user_id);
        await supabase
          .from('membership_requests')
          .update({ status: 'approved' })
          .eq('id', request_id);
        await bot.sendMessage(reqData.user.telegram_id, '✅ <b>¡Pago confirmado!</b>\nAhora eres usuario PREMIUM por 30 días.', { parse_mode: 'HTML' });
      }
    } else if (action === 'reject') {
      if (!reason) return res.status(400).send('Debe proporcionar un motivo');
      await supabase
        .from('membership_requests')
        .update({ status: 'rejected', rejection_reason: reason })
        .eq('id', request_id);
      await bot.sendMessage(reqData.user.telegram_id, `❌ <b>Tu solicitud ha sido rechazada.</b>\nMotivo: ${reason}`, { parse_mode: 'HTML' });
    }

    res.redirect(`/admin?telegram_id=${req.adminId}`);
  } catch (error) {
    logger.error(`Error procesando solicitud: ${error.message}`);
    res.status(500).send('Error interno');
  }
});

// Iniciar servidor web
app.listen(PORT, () => {
  logger.info(`✅ Servidor web escuchando en puerto ${PORT}`);
});

logger.info('✅ Bot iniciado correctamente');
