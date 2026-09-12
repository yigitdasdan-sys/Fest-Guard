require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// AYARLAR VE ID'LER
const EXEMPT_ROLE_ID = '1547917093058641961'; // İşlemlerden ve engellerden muaf yetkili rolü
const LOG_CHANNEL_ID = '1548383428930441258'; // Botun log atacağı kanal
const VOICE_CHANNEL_ID = '1547915520303435816'; // Botun 7/24 duracağı ses kanalı

const SPAM_LIMIT = 10; 
const SPAM_TIMEFRAME = 7000; 
const TIMEOUT_DURATION = 60 * 60 * 1000; 

const userMessageMap = new Map();

// Ses kanalına bağlanma fonksiyonu
function connectToVoiceChannel(guild) {
    try {
        const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
        if (!channel) return;

        joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true // Botun kulağını kapatır (performans tasarrufu)
        });
        console.log(`[SES] Bot ${channel.name} kanalına başarıyla bağlandı.`);
    } catch (error) {
        console.error('Ses kanalına bağlanırken hata:', error);
    }
}

// Log kanalına mesaj gönderme fonksiyonu
async function sendLog(guild, content) {
    try {
        const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
        if (logChannel) {
            await logChannel.send(content);
        }
    } catch (error) {
        console.error('Log gönderme hatası:', error);
    }
}

client.once('ready', async () => {
    console.log(`${client.user.tag} aktif! Koruma ve ses sistemleri devreye girdi.`);
    
    // Bot açıldığında sunucuyu bulup ses kanalına girer
    client.guilds.cache.forEach(guild => {
        connectToVoiceChannel(guild);
    });
});

// SES KANALI KORUMASI VE 7/24 BAĞLANTI
client.on('voiceStateUpdate', async (oldState, newState) => {
    // Sadece botun kendi ses durumunu kontrol et
    if (oldState.member.id !== client.user.id) return;

    // Eğer bot bir ses kanalından çıkarıldıysa/bağlantısı kesildiyse
    if (oldState.channelId && !newState.channelId) {
        try {
            const fetchedLogs = await oldState.guild.fetchAuditLogs({
                limit: 1,
                type: AuditLogEvent.MemberDisconnect,
            });
            const disconnectLog = fetchedLogs.entries.first();

            if (disconnectLog) {
                const { executor, target } = disconnectLog;

                // Eğer bağlantıyı kesen kişi hedef olarak botu seçtiyse ve işlem son 5sn içinde olduysa
                if (target.id === client.user.id && (Date.now() - disconnectLog.createdTimestamp < 5000)) {
                    const executorMember = await oldState.guild.members.fetch(executor.id).catch(() => null);

                    // Bağlantıyı kesen kişi muaf role sahip DEĞİLSE
                    if (!executorMember || !executorMember.roles.cache.has(EXEMPT_ROLE_ID)) {
                        await sendLog(
                            oldState.guild,
                            `⚠️ **[SES KORUMASI]** ${client.user} botu <@${executor.id}> tarafından sesten çıkarılmaya çalışıldı! İzinsiz işlem engellendi ve bot sese geri bağlandı.`
                        );
                    }
                }
            }
        } catch (error) {
            console.error('Audit log çekme hatası:', error);
        }

        // Muaf biri çıkarsa da, izinsiz biri çıkarsa da bot kanala geri girer
        setTimeout(() => {
            connectToVoiceChannel(oldState.guild);
        }, 1000);
    }
});

// SPAM VE REKLAM KORUMASI
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // MUAF ROL (WHITELIST) KONTROLÜ
    if (message.member && message.member.roles.cache.has(EXEMPT_ROLE_ID)) {
        return;
    }

    const { author, member, content, guild } = message;

    // REKLAM KORUMASI
    const inviteRegex = /(discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[a-zA-Z0-9]+/i;

    if (inviteRegex.test(content)) {
        try {
            if (message.deletable) await message.delete();

            if (member && member.kickable) {
                await member.kick('Sunucu davet linki (reklam) paylaştığı için otomatik atıldı.');
                await sendLog(
                    guild,
                    `🚨 **[REKLAM KORUMASI]** ${author} (\`${author.id}\`) sunucu davet linki paylaştığı için sunucudan atıldı!`
                );
            } else {
                await sendLog(
                    guild,
                    `⚠️ **[REKLAM KORUMASI]** ${author} reklam yaptı ancak yetkim yetersiz olduğu için atılamadı.`
                );
            }
        } catch (error) {
            console.error('Reklam koruması hatası:', error);
        }
        return;
    }

    // SPAM KORUMASI
    const currentTime = Date.now();
    let userData = userMessageMap.get(author.id);

    if (!userData) {
        userData = {
            lastMessageTime: currentTime,
            timestamps: [currentTime]
        };
        userMessageMap.set(author.id, userData);
    } else {
        userData.timestamps = userData.timestamps.filter(timestamp => currentTime - timestamp < SPAM_TIMEFRAME);
        userData.timestamps.push(currentTime);

        if (userData.timestamps.length >= SPAM_LIMIT) {
            try {
                if (member && member.moderatable) {
                    await member.timeout(TIMEOUT_DURATION, 'Hızlı şekilde 10 mesaj spamı yaptığı için 1 saat zaman aşımı uygulandı.');
                    
                    const infoMsg = await message.channel.send(`${author}, kısa sürede çok fazla mesaj attığın için **1 saat** boyunca zaman aşımına uğratıldın.`);
                    setTimeout(() => infoMsg.delete().catch(() => {}), 5000);

                    await sendLog(
                        guild,
                        `🔇 **[SPAM KORUMASI]** ${author} (\`${author.id}\`) üst üste 10 mesaj attığı için **1 saat** zaman aşımı cezası aldı.`
                    );
                }
                userMessageMap.delete(author.id);
            } catch (error) {
                console.error('Spam koruması hatası:', error);
            }
        }
    }
});
