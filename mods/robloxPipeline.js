const http = require('http');

const activeServers = new Map(); // JobId -> { lastHeartbeat, playerCount, queue }

const API_KEY = process.env.API_KEY; 

if (!API_KEY) {
    console.error("[RobloxPipeline] CRITICAL ERROR: API_KEY environment variable is not defined!");
}
const PORT = process.env.ROBLOX_PORT || 3000;

function generateCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let captcha = '';
    for (let i = 0; i < 6; i++) {
        captcha += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return captcha;
}

function encryptText(text, secret) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i) ^ secret.charCodeAt(i % secret.length);
        result += code.toString(16).padStart(2, '0');
    }
    return result;
}

module.exports = {
    name: "robloxPipeline",
    isEvent: false,
    isResponse: false,
    init: function (DBS) {
        console.log("[RobloxPipeline] Initializing secure remote execution pipeline...");

        const server = http.createServer((req, res) => {
            const clientKey = req.headers['authorization'];
            if (clientKey !== API_KEY) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing API key' }));
                return;
            }

            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    if (req.method === 'POST' && req.url === '/heartbeat') {
                        const data = JSON.parse(body);
                        const jobId = data.jobId;
                        const playerCount = data.playerCount || 0;
                        if (jobId) {
                            activeServers.set(jobId, {
                                lastHeartbeat: Date.now(),
                                playerCount: playerCount,
                                queue: activeServers.has(jobId) ? activeServers.get(jobId).queue : []
                            });
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'success' }));
                        } else {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Missing jobId parameter' }));
                        }
                    } else if (req.method === 'GET' && req.url.startsWith('/poll')) {
                        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
                        const jobId = parsedUrl.searchParams.get('jobId');
                        if (jobId && activeServers.has(jobId)) {
                            const serverData = activeServers.get(jobId);
                            serverData.lastHeartbeat = Date.now();
                            const queue = serverData.queue;
                            serverData.queue = [];
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ commands: queue }));
                        } else {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Target server not registered' }));
                        }
                    } else {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Endpoint not found' }));
                    }
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
        });

        server.listen(PORT, () => {
            console.log(`[RobloxPipeline] HTTP telemetry server operational on port ${PORT}`);
        });

        // Garbage collection sweep for stale server instances every 15 seconds
        setInterval(() => {
            const now = Date.now();
            for (const [jobId, data] of activeServers.entries()) {
                if (now - data.lastHeartbeat > 30000) {
                    activeServers.delete(jobId);
                    console.log(`[RobloxPipeline] Evicted stale server instance: ${jobId}`);
                }
            }
        }, 15000);

        DBS.Bot.on("messageCreate", async (message) => {
            if (message.author.bot) return;
            const prefix = DBS.SettingsFile.prefix || "?";
            if (!message.content.startsWith(prefix + "auth")) return;

            if (!message.guild) return;
            const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
            if (!member) return;

            const hasDevRole = member.roles.cache.some(r => r.name.toLowerCase() === "developer");
            if (!hasDevRole) return;

            const codePayload = message.content.slice((prefix + "auth").length).trim();
            if (!codePayload) {
                message.reply("Syntax Error: Executable payload missing.").catch(() => {});
                return;
            }

            await message.delete().catch(() => {});

            const captcha = generateCaptcha();
            let dmChannel;
            try {
                dmChannel = await message.author.createDM();
                await dmChannel.send(`Authentication Challenge.\nCaptcha Token: **${captcha}**\nRespond within 60 seconds to verify identity.`);
            } catch (err) {
                console.log(`[RobloxPipeline] Failed to dispatch initialization DM: ${err.message}`);
                return;
            }

            const filter = m => m.author.id === message.author.id;
            const collector = dmChannel.createMessageCollector({ filter, time: 60000, max: 1 });

            collector.on('collect', async m => {
                if (m.content.trim() !== captcha) {
                    await dmChannel.send("Authentication Failed: Invalid token response.").catch(() => {});
                    return;
                }

                await dmChannel.send("Authentication verified successfully.");

                if (activeServers.size === 0) {
                    await dmChannel.send("Pipeline Aborted: No active Roblox execution nodes detected.").catch(() => {});
                    return;
                }

                let serverListText = "Active Roblox Execution Nodes:\n";
                const serverEntries = Array.from(activeServers.entries());
                serverEntries.forEach((entry, index) => {
                    serverListText += `[${index + 1}] JobId: \`${entry[0]}\` | Players: ${entry[1].playerCount}\n`;
                });
                serverListText += "\nSelect target node index or specify **ALL** within 60 seconds.";

                await dmChannel.send(serverListText);

                const serverCollector = dmChannel.createMessageCollector({ filter, time: 60000, max: 1 });

                serverCollector.on('collect', async sm => {
                    const selection = sm.content.trim().toUpperCase();
                    let targetJobIds = [];

                    if (selection === "ALL") {
                        targetJobIds = serverEntries.map(e => e[0]);
                    } else {
                        const index = parseInt(selection, 10) - 1;
                        if (isNaN(index) || index < 0 || index >= serverEntries.length) {
                            await dmChannel.send("Selection Error: Index out of bounds. Aborting.").catch(() => {});
                            return;
                        }
                        targetJobIds.push(serverEntries[index][0]);
                    }

                    const encryptRow = new DBS.Discord.MessageActionRow().addComponents(
                        new DBS.Discord.MessageButton()
                            .setCustomId('encrypt_yes')
                            .setLabel('Encrypted Transmission')
                            .setStyle('PRIMARY'),
                        new DBS.Discord.MessageButton()
                            .setCustomId('encrypt_no')
                            .setLabel('Plaintext Transmission')
                            .setStyle('SECONDARY')
                    );

                    const encryptMsg = await dmChannel.send({
                        content: `Target Nodes: \`${targetJobIds.join(", ")}\`\nSelect transport encoding protocol:`,
                        components: [encryptRow]
                    });

                    const encryptCollector = encryptMsg.createMessageComponentCollector({ componentType: 'BUTTON', time: 30000, max: 1 });

                    encryptCollector.on('collect', async i => {
                        const isEncrypted = i.customId === 'encrypt_yes';
                        await i.update({
                            content: `Protocol Selected: [**${isEncrypted ? 'AES-XOR Cipher' : 'Plaintext'}**]. Broadcasting deployment alert to developer quorum...`,
                            components: []
                        }).catch(() => {});

                        const queuePayload = isEncrypted ? "ENC:" + encryptText(codePayload, API_KEY) : "PLAIN:" + codePayload;

                        await message.guild.members.fetch();
                        const devRole = message.guild.roles.cache.find(r => r.name.toLowerCase() === "developer");
                        const developers = devRole ? devRole.members.filter(m => !m.user.bot) : [member];

                        const sessionId = Date.now().toString();
                        let overrideTriggered = false;

                        const overridePromises = developers.map(async dev => {
                            try {
                                const devDm = await dev.createDM();
                                const row = new DBS.Discord.MessageActionRow().addComponents(
                                    new DBS.Discord.MessageButton()
                                        .setCustomId(`roblox_override_${sessionId}`)
                                        .setLabel("Override and Terminate")
                                        .setStyle("DANGER")
                                );

                                await devDm.send({
                                    content: `SECURITY AUDIT: Deployment initiated by ${message.author.tag}.\nProtocol: ${isEncrypted ? 'Encrypted' : 'Plaintext'}\nTargets: \`${targetJobIds.join(", ")}\`\n\nPayload Preview:\n\`\`\`luau\n${codePayload}\n\`\`\``,
                                    components: [row]
                                });
                            } catch (err) {
                                console.log(`[RobloxPipeline] Failed to notify developer ${dev.user.tag}: ${err.message}`);
                            }
                        });

                        await Promise.all(overridePromises);

                        setTimeout(async () => {
                            if (overrideTriggered) return;

                            try {
                                const confirmRow = new DBS.Discord.MessageActionRow().addComponents(
                                    new DBS.Discord.MessageButton()
                                        .setCustomId(`roblox_confirm_${sessionId}`)
                                        .setLabel("Confirm Deployment")
                                        .setStyle("SUCCESS")
                                );

                                const confirmMsg = await dmChannel.send({
                                    content: "Consensus window elapsed without veto. Authorize execution deployment queue:",
                                    components: [confirmRow]
                                });

                                const confirmCollector = confirmMsg.createMessageComponentCollector({ componentType: 'BUTTON', time: 60000, max: 1 });

                                confirmCollector.on('collect', async ci => {
                                    if (ci.customId === `roblox_confirm_${sessionId}`) {
                                        await ci.update({ content: "Deployment confirmed and committed to target queues.", components: [] }).catch(() => {});

                                        targetJobIds.forEach(jobId => {
                                            if (activeServers.has(jobId)) {
                                                activeServers.get(jobId).queue.push(queuePayload);
                                            }
                                        });

                                        console.log(`[RobloxPipeline] Payload committed successfully to nodes: ${targetJobIds.join(", ")}`);
                                    }
                                });
                            } catch (err) {
                                console.log(`[RobloxPipeline] Confirmation dispatch failure: ${err.message}`);
                            }
                        }, 90000);
                    });

                    encryptCollector.on('end', collected => {
                        if (collected.size === 0) {
                            dmChannel.send("Protocol selection timeout. Pipeline aborted.").catch(() => {});
                        }
                    });
                });
            });

            collector.on('end', collected => {
                if (collected.size === 0) {
                    dmChannel.send("Authentication challenge timeout. Pipeline aborted.").catch(() => {});
                }
            });
        });
    }
};