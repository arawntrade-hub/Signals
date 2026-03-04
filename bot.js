require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

// ================== CONFIGURACIÓN ==================
const token = process.env.TELEGRAM_TOKEN;
const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()));
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const cubaTz = process.env.CUBA_TZ || 'America/Havana';
const BOT_USERNAME = process.env.BOT_USERNAME || 'TuBot'; // para enlaces

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

// Inicializar bot con polling y manejo de errores
const bot = new TelegramBot(token, { polling: true });

// Inicializar Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

// Crear bucket si no existe (opcional, se puede hacer manual)
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

// Obtener hora actual en Cuba
function getCubaNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: cubaTz }));
}

// Validar ID de Quotex (ejemplo: alfanumérico de 6-20 caracteres)
function isValidQuotexId(id) {
  return /^[a-zA-Z0-9]{6,20}$/.test(id);
}

// Validar teléfono cubano (opcional, ajusta según necesidad)
function isValidCubanPhone(phone) {
  return /^[0-9]{8,12}$/.test(phone); // simple, sin código de país
}

// ================== SISTEMA DE COLAS PARA MENSAJES MASIVOS ==================
class MessageQueue {
  constructor(bot, delayMs = 50) {
    this.bot = bot;
    this.delayMs = delayMs;
    this.queue = [];
    this.processing = false;
  }

  async add(chatId, text, options = {}) {
    this.queue.push({ chatId, text, options });
    if (!this.processing) {
      this.processing = true;
      this.process();
    }
  }

  async process() {
    while (this.queue.length > 0) {
      const { chatId, text, options } = this.queue.shift();
      try {
        await this.bot.sendMessage(chatId, text, options);
      } catch (err) {
        logger.error(`Error enviando mensaje a ${chatId}: ${err.message}`);
        // Si es rate limit, esperar y reintentar? Por simplicidad, ignoramos.
      }
      // Pequeña pausa entre mensajes
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
    this.processing = false;
  }
}

const messageQueue = new MessageQueue(bot, 100); // 100ms entre mensajes

// ================== GESTIÓN DE ESTADOS DEL ADMIN (PERSISTENTE) ==================
async function getAdminState(chatId) {
  const { data, error } = await supabase
    .from('admin_states')
    .select('step, data')
    .eq('chat_id', chatId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function setAdminState(chatId, step, data = {}) {
  const { error } = await supabase
    .from('admin_states')
    .upsert({ chat_id: chatId, step, data }, { onConflict: 'chat_id' });
  if (error) throw error;
}

async function clearAdminState(chatId) {
  const { error } = await supabase
    .from('admin_states')
    .delete()
    .eq('chat_id', chatId);
  if (error) throw error;
}

// ================== SUBIR IMAGEN A SUPABASE STORAGE ==================
async function uploadPhotoToSupabase(fileId, userId) {
  try {
    // Obtener enlace de descarga de Telegram
    const fileLink = await bot.getFileLink(fileId);
    // Descargar imagen
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');

    // Generar nombre único
    const fileName = `user_${userId}_${uuidv4()}.jpg`;

    // Subir a Supabase Storage
    const { data, error } = await supabase.storage
      .from('payment-screenshots')
      .upload(fileName, buffer, { contentType: 'image/jpeg' });

    if (error) throw error;

    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from('payment-screenshots')
      .getPublicUrl(fileName);

    return urlData.publicUrl;
  } catch (err) {
    logger.error(`Error subiendo imagen: ${err.message}`);
    throw err;
  }
}

// ================== IA MEJORADA CON CONTEXTO ==================
async function askIA(userId, userMessage) {
  // Recuperar historial reciente (últimos 10 mensajes)
  const { data: history, error } = await supabase
    .from('user_conversations')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    logger.error(`Error obteniendo historial IA: ${error.message}`);
  }

  // Construir mensajes en orden cronológico
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

  // Agregar historial (invertir para orden cronológico)
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
        model: 'stepfun/step-3.5-flash:free', // gratuito
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

    // Guardar en historial
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

// ================== COMANDOS PÚBLICOS ==================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const username = msg.from.username;

  try {
    await getOrCreateUser(telegramId, username);
    await bot.sendMessage(
      chatId,
      '¡Bienvenido al bot de señales de trading!\n\n'
      + 'Usa /planes para ver los planes disponibles.\n'
      + 'Usa /estadisticas para ver las estadísticas según tu membresía.\n'
      + 'Usa /historial para ver las últimas señales que has recibido.\n'
      + 'Usa /ayuda para más información.\n'
      + 'Si eres administrador, usa /admin para el panel.'
    );
  } catch (error) {
    logger.error(`Error en /start: ${error.message}`);
    await bot.sendMessage(chatId, 'Ocurrió un error. Intenta más tarde.');
  }
});

bot.onText(/\/ayuda/, async (msg) => {
  const chatId = msg.chat.id;
  const helpText = `
📚 *Ayuda del bot*

*Comandos disponibles:*
/start - Iniciar el bot
/planes - Ver y elegir planes de membresía
/estadisticas - Ver estadísticas de señales
/historial - Ver tus últimas señales recibidas
/ayuda - Mostrar este mensaje

*Para administradores:*
/admin - Panel de administración
/cancelar - Cancelar cualquier flujo en curso

*Plan Básico (gratis):*
- 5 señales por sesión (2 sesiones diarias)
- Estadísticas desde tu registro
- Sin acceso a IA

*Plan Premium (3000 CUP/mes):*
- 10 señales por sesión
- Estadísticas desde el inicio del bot
- Acceso a IA para consultas de trading
- Estrategias y contenido exclusivo

Para contratar, usa /planes.
  `;
  await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/planes/, async (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    inline_keyboard: [
      [{ text: 'Plan Básico (gratis)', callback_data: 'plan_free' }],
      [{ text: 'Plan Premium (3000 CUP/mes)', callback_data: 'plan_premium' }],
    ],
  };
  await bot.sendMessage(chatId, 'Elige un plan:', { reply_markup: keyboard });
});

bot.onText(/\/estadisticas/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  try {
    const user = await getUser(telegramId);
    if (!user || !user.approved) {
      return bot.sendMessage(chatId, 'Debes registrarte y ser aprobado. Usa /planes.');
    }

    let query = supabase.from('signals').select('*');
    if (user.membership === 'free') {
      query = query.gte('created_at', user.created_at);
    }
    // Para premium, todas las señales

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
  } catch (error) {
    logger.error(`Error en estadisticas: ${error.message}`);
    await bot.sendMessage(chatId, 'Error al obtener estadísticas.');
  }
});

bot.onText(/\/historial/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  try {
    const user = await getUser(telegramId);
    if (!user || !user.approved) {
      return bot.sendMessage(chatId, 'Regístrate primero.');
    }

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
  } catch (error) {
    logger.error(`Error en historial: ${error.message}`);
    await bot.sendMessage(chatId, 'Error al obtener historial.');
  }
});

// Comando /cancelar para admins (y también para usuarios si se quiere, pero solo admin por ahora)
bot.onText(/\/cancelar/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  if (!isAdmin(telegramId)) return;
  try {
    await clearAdminState(chatId);
    await bot.sendMessage(chatId, '✅ Flujo cancelado.');
  } catch (err) {
    logger.error(`Error en /cancelar: ${err.message}`);
    await bot.sendMessage(chatId, 'Error al cancelar.');
  }
});

// ================== MANEJADOR DE CALLBACKS ==================
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = msg.chat.id;
  const telegramId = callbackQuery.from.id;
  const messageId = msg.message_id;

  await bot.answerCallbackQuery(callbackQuery.id);

  try {
    const user = await getOrCreateUser(telegramId, callbackQuery.from.username);

    // ===== PLANES =====
    if (data === 'plan_free') {
      // Verificar si ya tiene solicitud pendiente
      const { data: existing, error } = await supabase
        .from('membership_requests')
        .select('id')
        .eq('user_id', user.id)
        .eq('type', 'free')
        .eq('status', 'pending')
        .maybeSingle();

      if (existing) {
        return bot.editMessageText('Ya tienes una solicitud pendiente. Espera la respuesta del admin.', {
          chat_id: chatId,
          message_id: messageId,
        });
      }

      // Crear solicitud
      await supabase.from('membership_requests').insert([{
        user_id: user.id,
        type: 'free',
      }]);

      await bot.editMessageText(
        'Para acceder al plan básico:\n'
        + '1. Regístrate en Quotex usando este enlace: [ENLACE_DE_REFERIDO]\n'
        + '2. Asegúrate de que la cuenta sea NUEVA.\n'
        + '3. Una vez registrado, envía /enviar_id <tu ID de Quotex>',
        { chat_id: chatId, message_id: messageId }
      );

      // Notificar a admin
      for (const adminId of adminIds) {
        await bot.sendMessage(
          adminId,
          `Nueva solicitud básica de @${callbackQuery.from.username || telegramId}.\n`
          + `Usuario ID: ${telegramId}\n`
          + `Para aprobar/rechazar, usa /admin`
        );
      }
    }

    else if (data === 'plan_premium') {
      const { data: existing, error } = await supabase
        .from('membership_requests')
        .select('id')
        .eq('user_id', user.id)
        .eq('type', 'premium')
        .eq('status', 'pending')
        .maybeSingle();

      if (existing) {
        return bot.editMessageText('Ya tienes una solicitud premium pendiente.', {
          chat_id: chatId,
          message_id: messageId,
        });
      }

      await supabase.from('membership_requests').insert([{
        user_id: user.id,
        type: 'premium',
      }]);

      await bot.editMessageText(
        'Para acceder al plan premium:\n'
        + '1. Regístrate en Quotex usando este enlace: [ENLACE_DE_REFERIDO]\n'
        + '2. Envía tu ID de Quotex con /enviar_id <ID>\n\n'
        + 'Una vez aprobado ese paso, te pediremos los datos de pago.',
        { chat_id: chatId, message_id: messageId }
      );

      for (const adminId of adminIds) {
        await bot.sendMessage(
          adminId,
          `Nueva solicitud premium de @${callbackQuery.from.username || telegramId}. Requiere verificación de Quotex.`
        );
      }
    }

    // ===== ADMIN: GESTIÓN DE SOLICITUDES =====
    else if (data.startsWith('approve_')) {
      if (!isAdmin(telegramId)) return;
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
        // Premium: después de aprobar Quotex, pedir pago
        await supabase
          .from('membership_requests')
          .update({ status: 'pending_payment' })
          .eq('id', reqId);

        await bot.editMessageText(
          `Solicitud premium #${reqId} aprobada (Quotex verificado). Ahora pide al usuario que envíe teléfono y pago.`,
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

    else if (data.startsWith('reject_')) {
      if (!isAdmin(telegramId)) return;
      const reqId = parseInt(data.split('_')[1]);
      // Guardar en estado del admin el motivo pendiente
      await setAdminState(chatId, 'reject_reason', { reqId });
      await bot.editMessageText('Envía el motivo del rechazo:', { chat_id: chatId, message_id: messageId });
    }

    else if (data.startsWith('pay_accept_')) {
      if (!isAdmin(telegramId)) return;
      const reqId = parseInt(data.split('_')[2]);
      const { data: req, error } = await supabase
        .from('membership_requests')
        .select('*, user:users(*)')
        .eq('id', reqId)
        .single();

      if (error || !req) return bot.editMessageText('Solicitud no encontrada.', { chat_id: chatId, message_id: messageId });

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

      await bot.editMessageText(`Pago aceptado. Usuario premium hasta ${premiumUntil.toLocaleDateString()}.`, { chat_id: chatId, message_id: messageId });
      await bot.sendMessage(
        req.user.telegram_id,
        '✅ ¡Pago confirmado! Ahora eres usuario PREMIUM por 30 días. Disfruta de todas las señales y la IA.'
      );
    }

    else if (data.startsWith('pay_reject_')) {
      if (!isAdmin(telegramId)) return;
      const reqId = parseInt(data.split('_')[2]);
      await supabase
        .from('membership_requests')
        .update({ status: 'rejected' })
        .eq('id', reqId);

      await bot.editMessageText('Pago rechazado.', { chat_id: chatId, message_id: messageId });

      const { data: req } = await supabase
        .from('membership_requests')
        .select('user:users(telegram_id)')
        .eq('id', reqId)
        .single();

      if (req) {
        await bot.sendMessage(req.user.telegram_id, '❌ Tu pago no pudo ser verificado. Contacta al admin para más detalles.');
      }
    }

    // ===== ADMIN: GESTIÓN DE SESIONES Y SEÑALES =====
    else if (data === 'admin_open_session') {
      if (!isAdmin(telegramId)) return;

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

      // Notificar a todos los usuarios aprobados usando cola
      const { data: users } = await supabase.from('users').select('telegram_id').eq('approved', true);
      for (const u of users || []) {
        await messageQueue.add(u.telegram_id, '🟢 Sesión de trading INICIADA');
      }
    }

    else if (data === 'admin_close_session') {
      if (!isAdmin(telegramId)) return;

      const { data: session, error } = await supabase
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
        await messageQueue.add(u.telegram_id, '🔴 Sesión de trading FINALIZADA');
      }
    }

    else if (data === 'admin_new_signal') {
      if (!isAdmin(telegramId)) return;

      const { data: session } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'open')
        .maybeSingle();

      if (!session) {
        return bot.editMessageText('No hay una sesión abierta. Abre una primero.', { chat_id: chatId, message_id: messageId });
      }

      // Guardar estado: paso asset
      await setAdminState(chatId, 'signal_asset', { sessionId: session.id });
      await bot.editMessageText('Envía el activo (ej. EURUSD):', { chat_id: chatId, message_id: messageId });
    }

    else if (data.startsWith('tf_')) {
      if (!isAdmin(telegramId)) return;
      const tf = data.split('_')[1];
      const state = await getAdminState(chatId);
      if (!state || !state.data || !state.data.asset) return;

      await setAdminState(chatId, 'signal_timeframe', { ...state.data, timeframe: tf });

      const keyboard = {
        inline_keyboard: [
          [{ text: '⬆️', callback_data: 'dir_up' }],
          [{ text: '⬇️', callback_data: 'dir_down' }],
        ],
      };
      await bot.editMessageText('Selecciona dirección:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
      });
    }

    else if (data.startsWith('dir_')) {
      if (!isAdmin(telegramId)) return;
      const direction = data === 'dir_up' ? 'up' : 'down';
      const state = await getAdminState(chatId);
      if (!state || !state.data || !state.data.asset || !state.data.timeframe || !state.data.sessionId) return;

      const { asset, timeframe, sessionId } = state.data;

      // Obtener último índice
      const { data: lastSignal } = await supabase
        .from('signals')
        .select('signal_index')
        .eq('session_id', sessionId)
        .order('signal_index', { ascending: false })
        .limit(1)
        .maybeSingle();

      const nextIndex = lastSignal ? lastSignal.signal_index + 1 : 1;

      // Insertar señal (usar transacción si fuera posible, pero Supabase no soporta transacciones cross-table fácilmente)
      const { data: signal, error } = await supabase
        .from('signals')
        .insert([{
          session_id: sessionId,
          signal_index: nextIndex,
          asset,
          timeframe,
          direction,
        }])
        .select()
        .single();

      if (error) throw error;

      // Obtener todos los usuarios aprobados
      const { data: users } = await supabase
        .from('users')
        .select('id, telegram_id, membership')
        .eq('approved', true);

      // Para cada usuario, verificar cuántas señales ha recibido en esta sesión
      for (const user of users || []) {
        // Obtener IDs de señales de esta sesión
        const { data: sessionSignals } = await supabase
          .from('signals')
          .select('id')
          .eq('session_id', sessionId);

        const signalIds = sessionSignals.map(s => s.id);
        const { count } = await supabase
          .from('signal_deliveries')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('signal_id', signalIds);

        const maxAllowed = user.membership === 'premium' ? 10 : 5;
        if (count >= maxAllowed) continue;

        // Enviar mensaje
        const emoji = direction === 'up' ? '⬆️' : '⬇️';
        const text = `📈 *Señal #${nextIndex}*\nActivo: ${asset}\nTiempo: ${timeframe}\nDirección: ${emoji}`;
        try {
          await bot.sendMessage(user.telegram_id, text, { parse_mode: 'Markdown' });
          // Registrar entrega
          await supabase.from('signal_deliveries').insert([{
            signal_id: signal.id,
            user_id: user.id,
          }]);
        } catch (err) {
          logger.error(`Error enviando a ${user.telegram_id}: ${err.message}`);
        }
      }

      // Ofrecer mantener activo
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Mantener activo', callback_data: 'keep_asset' }],
          [{ text: 'Nuevo activo', callback_data: 'new_asset' }],
        ],
      };
      await bot.editMessageText(
        `Señal #${nextIndex} enviada.\n¿Deseas mantener el activo ${asset}?`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: keyboard,
        }
      );
    }

    else if (data === 'keep_asset') {
      if (!isAdmin(telegramId)) return;
      const state = await getAdminState(chatId);
      if (!state || !state.data || !state.data.asset) return;
      await setAdminState(chatId, 'signal_timeframe', { ...state.data }); // pasamos a elegir timeframe
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

    else if (data === 'new_asset') {
      if (!isAdmin(telegramId)) return;
      const state = await getAdminState(chatId);
      if (!state || !state.data || !state.data.sessionId) return;
      await setAdminState(chatId, 'signal_asset', { sessionId: state.data.sessionId });
      await bot.editMessageText('Envía el nuevo activo (ej. EURUSD):', {
        chat_id: chatId,
        message_id: messageId,
      });
    }

    else if (data.startsWith('result_')) {
      if (!isAdmin(telegramId)) return;
      const parts = data.split('_');
      const signalId = parseInt(parts[1]);
      const result = parts[2]; // profit o loss

      await supabase
        .from('signals')
        .update({ result })
        .eq('id', signalId);

      await bot.editMessageText(`Resultado de señal #${signalId} guardado: ${result.toUpperCase()}`, {
        chat_id: chatId,
        message_id: messageId,
      });
    }

    else if (data === 'admin_pending_requests') {
      if (!isAdmin(telegramId)) return;
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

    else if (data === 'admin_pending_results') {
      if (!isAdmin(telegramId)) return;
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
      await bot.deleteMessage(chatId, messageId); // opcional
    }

  } catch (error) {
    logger.error(`Error en callback: ${error.message}`);
    await bot.sendMessage(chatId, 'Ocurrió un error interno.');
  }
});

// ================== COMANDOS DE REGISTRO ==================
bot.onText(/\/enviar_id (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const quotexId = match[1].trim();

  try {
    // Validar formato
    if (!isValidQuotexId(quotexId)) {
      return bot.sendMessage(chatId, '❌ El ID de Quotex no es válido. Debe tener entre 6 y 20 caracteres alfanuméricos.');
    }

    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, 'Primero usa /planes.');

    const { data: req } = await supabase
      .from('membership_requests')
      .select('id, type')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (!req) return bot.sendMessage(chatId, 'No tienes una solicitud activa.');

    await supabase.from('users').update({ quotex_id: quotexId }).eq('id', user.id);

    await bot.sendMessage(chatId, '✅ ID recibido. Espera la confirmación del admin.');

    for (const adminId of adminIds) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Aprobar', callback_data: `approve_${req.id}` },
            { text: '❌ Rechazar', callback_data: `reject_${req.id}` },
          ],
        ],
      };
      await bot.sendMessage(
        adminId,
        `Usuario @${msg.from.username || telegramId} envió ID de Quotex: ${quotexId}\n`
        + `Solicitud #${req.id} tipo: ${req.type}`,
        { reply_markup: keyboard }
      );
    }
  } catch (error) {
    logger.error(`Error en /enviar_id: ${error.message}`);
    await bot.sendMessage(chatId, 'Error al procesar.');
  }
});

bot.onText(/\/enviar_telefono (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const phone = match[1].trim();

  try {
    if (!isValidCubanPhone(phone)) {
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

    await supabase
      .from('membership_requests')
      .update({ phone_number: phone })
      .eq('id', req.id);

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

    // Subir foto a Supabase Storage
    const publicUrl = await uploadPhotoToSupabase(photo.file_id, user.id);

    await supabase
      .from('membership_requests')
      .update({ payment_screenshot_file_id: publicUrl }) // guardamos URL
      .eq('id', req.id);

    await bot.sendMessage(chatId, '✅ Captura recibida. Espera la confirmación del admin.');

    // Obtener teléfono
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

// ================== COMANDOS DE ADMIN ==================
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  if (!isAdmin(telegramId)) {
    return bot.sendMessage(chatId, 'No autorizado.');
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: 'Abrir sesión manual', callback_data: 'admin_open_session' }],
      [{ text: 'Cerrar sesión', callback_data: 'admin_close_session' }],
      [{ text: 'Nueva señal', callback_data: 'admin_new_signal' }],
      [{ text: 'Ver solicitudes pendientes', callback_data: 'admin_pending_requests' }],
      [{ text: 'Resultados pendientes', callback_data: 'admin_pending_results' }],
    ],
  };
  await bot.sendMessage(chatId, 'Panel de admin:', { reply_markup: keyboard });
});

// Manejar mensajes de texto de admin (flujos)
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  if (!isAdmin(telegramId)) {
    // Usuario normal: podría ser consulta a IA
    try {
      const user = await getUser(telegramId);
      if (!user || !user.approved || user.membership !== 'premium') return;

      const now = getCubaNow();
      const hour = now.getHours();
      const minute = now.getMinutes();
      const isTradingTime = (hour === 10 && minute < 30) || (hour === 22 && minute < 30);
      if (isTradingTime) {
        return bot.sendMessage(chatId, '⏳ Estamos en horario de trading. Vuelve después de la sesión para hacer preguntas.');
      }

      const reply = await askIA(user.id, msg.text);
      await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Error en IA usuario: ${err.message}`);
      await bot.sendMessage(chatId, 'Lo siento, ahora no puedo procesar tu consulta. Intenta más tarde.');
    }
    return;
  }

  // Admin: manejar flujos pendientes
  const state = await getAdminState(chatId);
  if (!state) return;

  if (state.step === 'reject_reason') {
    const reason = msg.text;
    const reqId = state.data.reqId;
    await clearAdminState(chatId);

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
        await bot.sendMessage(req.user.telegram_id, `❌ Tu solicitud ha sido rechazada. Motivo: ${reason}`);
      }
      await bot.sendMessage(chatId, `Rechazo notificado para solicitud #${reqId}.`);
    } catch (err) {
      logger.error(`Error en rechazo: ${err.message}`);
      await bot.sendMessage(chatId, 'Error al procesar rechazo.');
    }
  }
  else if (state.step === 'signal_asset') {
    const asset = msg.text.toUpperCase();
    // Validar activo (opcional, podría ser cualquier cosa)
    if (asset.length < 2) {
      return bot.sendMessage(chatId, 'Activo demasiado corto. Intenta de nuevo.');
    }
    await setAdminState(chatId, 'signal_timeframe', { ...state.data, asset });
    const keyboard = {
      inline_keyboard: [
        [{ text: '30s', callback_data: 'tf_30s' }],
        [{ text: '1M', callback_data: 'tf_1M' }],
        [{ text: '2M', callback_data: 'tf_2M' }],
        [{ text: '5M', callback_data: 'tf_5M' }],
      ],
    };
    await bot.sendMessage(chatId, 'Selecciona temporalidad:', { reply_markup: keyboard });
  }
  else {
    await bot.sendMessage(chatId, 'Usa los botones para continuar o /cancelar para salir.');
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
          await messageQueue.add(u.telegram_id, '🟢 Sesión de trading INICIADA');
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
        await messageQueue.add(u.telegram_id, '🔴 Sesión de trading FINALIZADA');
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
    } catch (e) { /* ignorar */ }
  }
}, {
  timezone: cubaTz
});

logger.info('Bot iniciado correctamente');
