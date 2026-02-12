
import { Context } from "hono";
import { Telegraf, Context as TgContext, Markup } from "telegraf";
import { callbackQuery } from "telegraf/filters";

import { CONSTANTS } from "../constants";
import { getBooleanValue, getDomains, getJsonObjectValue, getStringValue } from '../utils';
import { TelegramSettings } from "./settings";
import { bindTelegramAddress, deleteTelegramAddress, jwtListToAddressData, tgUserNewAddress, unbindTelegramAddress, unbindTelegramByAddress } from "./common";
import { commonParseMail } from "../common";
import { UserFromGetMe } from "telegraf/types";
import i18n from "../i18n";
import { LocaleMessages } from "../i18n/type";

// Helper to get messages by userId
const getTgMessages = async (
    c: Context<HonoCustomType>,
    ctx?: TgContext,
    userId?: string | null
): Promise<LocaleMessages> => {
    // Check if user language config is enabled (default false)
    if (!getBooleanValue(c.env.TG_ALLOW_USER_LANG)) {
        return i18n.getMessages(c.env.DEFAULT_LANG || 'zh');
    }

    const uid = userId || ctx?.message?.from?.id?.toString() || ctx?.callbackQuery?.from?.id?.toString();
    if (uid) {
        const savedLang = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:lang:${uid}`);
        if (savedLang) { return i18n.getMessages(savedLang); }
    }
    return i18n.getMessages(c.env.DEFAULT_LANG || 'zh');
};

// Bilingual command descriptions with full usage instructions
const COMMANDS = [
    {
        command: "start",
        description: "开始使用 | Get started"
    },
    {
        command: "new",
        description: "新建邮箱, /new <name>@<domain>, name[a-z0-9]有效, 为空随机生成, @domain可选 | Create address, /new <name>@<domain>, name[a-z0-9] valid, empty=random, @domain optional"
    },
    {
        command: "address",
        description: "查看邮箱地址列表 | View address list"
    },
    {
        command: "bind",
        description: "绑定邮箱, /bind <邮箱地址凭证> | Bind address, /bind <credential>"
    },
    {
        command: "unbind",
        description: "解绑邮箱, /unbind <邮箱地址> | Unbind address, /unbind <address>"
    },
    {
        command: "delete",
        description: "删除邮箱, /delete <邮箱地址> | Delete address, /delete <address>"
    },
    {
        command: "mails",
        description: "查看邮件, /mails <邮箱地址>, 不输入地址默认第一个 | View mails, /mails <address>, default first if empty"
    },
    {
        command: "cleaninvalidaddress",
        description: "清理无效地址 | Clean invalid addresses"
    },
    {
        command: "lang",
        description: "设置语言 /lang <zh|en> | Set language /lang <zh|en>"
    },
	  {
			  command: "bindtopic",
			  description: "绑定话题 /bindtopic"
		},
]

export const getTelegramCommands = (c: Context<HonoCustomType>) => {
    return getBooleanValue(c.env.TG_ALLOW_USER_LANG)
        ? COMMANDS
        : COMMANDS.filter(cmd => cmd.command !== "lang");
}

export function newTelegramBot(c: Context<HonoCustomType>, token: string): Telegraf {
    const bot = new Telegraf(token);
    const botInfo = getJsonObjectValue<UserFromGetMe>(c.env.TG_BOT_INFO);
    if (botInfo) {
        bot.botInfo = botInfo;
    }

    bot.use(async (ctx, next) => {
		    const isPrivate = ctx.chat?.type === "private";
		    const isSupergroup = ctx.chat?.type === "supergroup";
		    const isGroup = ctx.chat?.type === "group";
		    
		    // 获取命令名称
		    const messageText = ctx?.message?.text || "";
		    const command = messageText.split(" ")[0].toLowerCase();
		    
		    // 允许在话题中使用的命令列表
		    const topicAllowedCommands = ["/bindtopic"];
		    
		    // 如果不是私聊,检查是否是允许的命令
		    if (!isPrivate) {
		        if (!topicAllowedCommands.includes(command)) {
		            return; // 其他命令在群组/话题中不响应
		        }
		    }
		
		    const userId = ctx?.message?.from?.id || ctx.callbackQuery?.message?.chat?.id;
		    if (!userId) {
		        const msgs = await getTgMessages(c, ctx);
		        return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
		    }
		
		    const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, "json");
		    if (settings?.enableAllowList
		        && !settings.allowList.includes(userId.toString())
		    ) {
		        const msgs = await getTgMessages(c, ctx);
		        return await ctx.reply(msgs.TgNoPermissionMsg);
		    }
		    try {
		        await next();
		    } catch (error) {
		        console.error(`Error: ${error}`);
		        return await ctx.reply(`Error: ${error}`);
		    }
		})

    bot.command("start", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const prefix = getStringValue(c.env.PREFIX)
        const domains = getDomains(c);
        const commands = getTelegramCommands(c);
        return await ctx.reply(
            `${msgs.TgWelcomeMsg}\n\n`
            + (prefix ? `${msgs.TgCurrentPrefixMsg} ${prefix}\n` : '')
            + `${msgs.TgCurrentDomainsMsg} ${JSON.stringify(domains)}\n`
            + `${msgs.TgAvailableCommandsMsg}\n`
            + commands.map(cmd => `/${cmd.command}: ${cmd.description}`).join("\n")
        );
    });

    bot.command("new", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            // @ts-ignore
            const address = ctx?.message?.text.slice("/new".length).trim();
            const res = await tgUserNewAddress(c, userId.toString(), address, msgs);
            return await ctx.reply(`${msgs.TgCreateSuccessMsg}\n`
                + `${msgs.TgAddressMsg} ${res.address}\n`
                + (res.password ? `${msgs.TgPasswordMsg} \`${res.password}\`\n` : '')
                + `${msgs.TgCredentialMsg} \`${res.jwt}\`\n`,
                {
                    parse_mode: "Markdown"
                }
            );
        } catch (e) {
            return await ctx.reply(`${msgs.TgCreateFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("bind", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            // @ts-ignore
            const jwt = ctx?.message?.text.slice("/bind".length).trim();
            if (!jwt) {
                return await ctx.reply(msgs.TgPleaseInputCredentialMsg);
            }
            const address = await bindTelegramAddress(c, userId.toString(), jwt, msgs);
            return await ctx.reply(`${msgs.TgBindSuccessMsg}\n`
                + `${msgs.TgAddressMsg} ${address}`
            );
        }
        catch (e) {
            return await ctx.reply(`${msgs.TgBindFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("unbind", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            // @ts-ignore
            const address = ctx?.message?.text.slice("/unbind".length).trim();
            if (!address) {
                return await ctx.reply(msgs.TgPleaseInputAddressMsg);
            }
            await unbindTelegramAddress(c, userId.toString(), address);
            return await ctx.reply(`${msgs.TgUnbindSuccessMsg}\n${msgs.TgAddressMsg} ${address}`
            );
        }
        catch (e) {
            return await ctx.reply(`${msgs.TgUnbindFailedMsg} ${(e as Error).message}`);
        }
    })

    bot.command("delete", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            // @ts-ignore
            const address = ctx?.message?.text.slice("/delete".length).trim();
            if (!address) {
                return await ctx.reply(msgs.TgPleaseInputAddressMsg);
            }
            await deleteTelegramAddress(c, userId.toString(), address, msgs);
            return await ctx.reply(`${msgs.TgDeleteSuccessMsg} ${address}`);
        } catch (e) {
            return await ctx.reply(`${msgs.TgDeleteFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("address", async (ctx) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            const jwtList = await c.env.KV.get<string[]>(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, 'json') || [];
            const { addressList } = await jwtListToAddressData(c, jwtList, msgs);
            return await ctx.reply(`${msgs.TgAddressListMsg}\n\n`
                + addressList.map(a => `${msgs.TgAddressMsg} ${a}`).join("\n")
            );
        } catch (e) {
            return await ctx.reply(`${msgs.TgGetAddressFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("cleaninvalidaddress", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            const jwtList = await c.env.KV.get<string[]>(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, 'json') || [];
            const { invalidJwtList } = await jwtListToAddressData(c, jwtList, msgs);
            const newJwtList = jwtList.filter(jwt => !invalidJwtList.includes(jwt));
            await c.env.KV.put(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, JSON.stringify(newJwtList));
            const { addressList } = await jwtListToAddressData(c, newJwtList, msgs);
            return await ctx.reply(`${msgs.TgCleanSuccessMsg}\n\n`
                + `${msgs.TgCurrentAddressListMsg}\n\n`
                + addressList.map(a => `${msgs.TgAddressMsg} ${a}`).join("\n")
            );
        } catch (e) {
            return await ctx.reply(`${msgs.TgCleanFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("lang", async (ctx: TgContext) => {
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            const msgs = await getTgMessages(c, ctx);
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }

        const msgs = await getTgMessages(c, ctx);

        // Check if user language config is enabled
        if (!getBooleanValue(c.env.TG_ALLOW_USER_LANG)) {
            return await ctx.reply(msgs.TgLangFeatureDisabledMsg);
        }

        // @ts-ignore
        const lang = ctx?.message?.text.slice("/lang".length).trim().toLowerCase();
        if (lang === 'zh' || lang === 'en') {
            await c.env.KV.put(`${CONSTANTS.TG_KV_PREFIX}:lang:${userId}`, lang);
            return await ctx.reply(`${msgs.TgLangSetSuccessMsg} ${lang === 'zh' ? '中文' : 'English'}`);
        }

        const currentLang = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:lang:${userId}`);
        return await ctx.reply(
            `${msgs.TgCurrentLangMsg} ${currentLang || 'auto'}\n`
            + `${msgs.TgSelectLangMsg}\n`
            + `/lang zh - 中文\n`
            + `/lang en - English`
        );
    });
		bot.command("bindtopic", async (ctx: TgContext) => {
		    const msgs = await getTgMessages(c, ctx);
		    const userId = ctx?.message?.from?.id;
		    const chatId = ctx?.message?.chat?.id;
		    const threadId = ctx?.message?.message_thread_id;
		    
		    if (!userId) {
		        return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
		    }
		    
		    // 检查是否在话题中
		    if (!threadId) {
		        return await ctx.reply("⚠️ 请在超级群组的话题中使用此命令!");
		    }
		    
		    try {
		        // 修复:应该是 "/bindtopic" 不是 "/bind"
		        const jwt = ctx?.message?.text.slice("/bindtopic".length).trim();
		        
		        if (!jwt) {
		            return await ctx.reply(msgs.TgPleaseInputCredentialMsg + "\n\n使用方法: /bindtopic <邮箱凭证>");
		        }
		        
		        const address = await bindTelegramAddress(c, userId.toString(), jwt, msgs);
		        
		        // 保存绑定信息到 address 键(用于接收邮件)
		        await c.env.KV.put(
		            `${CONSTANTS.TG_KV_PREFIX}:${address}`,
		            JSON.stringify({
		                userId: userId.toString(),
		                chatId: chatId,
		                threadId: threadId,
		                bindTime: new Date().toISOString()
		            })
		        );
		        
		        return await ctx.reply(
		            `${msgs.TgBindSuccessMsg}\n`
		            + `${msgs.TgAddressMsg} ${address}\n`
		            + `📍 话题 ID: ${threadId}\n`
		            + `✅ 新邮件将推送到此话题`
		        );
		    }
		    catch (e) {
		        return await ctx.reply(`${msgs.TgBindFailedMsg} ${(e as Error).message}`);
		    }
		});

	
    const queryMail = async (ctx: TgContext, queryAddress: string, mailIndex: number, edit: boolean) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id || ctx.callbackQuery?.message?.chat?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        const jwtList = await c.env.KV.get<string[]>(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, 'json') || [];
        const { addressList, addressIdMap } = await jwtListToAddressData(c, jwtList, msgs);
        if (!queryAddress && addressList.length > 0) {
            queryAddress = addressList[0];
        }
        if (!(queryAddress in addressIdMap)) {
            return await ctx.reply(`${msgs.TgNotBoundAddressMsg} ${queryAddress}`);
        }
        const address_id = addressIdMap[queryAddress];
        const db_address_id = await c.env.DB.prepare(
            `SELECT id FROM address where id = ? `
        ).bind(address_id).first("id");
        if (!db_address_id) {
            return await ctx.reply(msgs.TgInvalidAddressMsg);
        }
        const { raw, id: mailId, created_at } = await c.env.DB.prepare(
            `SELECT * FROM raw_mails where address = ? `
            + ` order by id desc limit 1 offset ?`
        ).bind(
            queryAddress, mailIndex
        ).first<{ raw: string, id: string, created_at: string }>() || {};
        const { mail } = raw ? await parseMail(msgs, { rawEmail: raw }, queryAddress, created_at) : { mail: msgs.TgNoMoreMailsMsg };
        const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, "json");
        const miniAppButtons = []
        if (settings?.miniAppUrl && settings?.miniAppUrl?.length > 0 && mailId) {
            const url = new URL(settings.miniAppUrl);
            url.pathname = "/telegram_mail"
            url.searchParams.set("mail_id", mailId);
            miniAppButtons.push(Markup.button.webApp(msgs.TgViewMailBtnMsg, url.toString()));
        }
        if (edit) {
            return await ctx.editMessageText(mail || msgs.TgNoMailMsg,
                {
                    ...Markup.inlineKeyboard([
                        Markup.button.callback(msgs.TgPrevBtnMsg, `mail_${queryAddress}_${mailIndex - 1}`, mailIndex <= 0),
                        ...miniAppButtons,
                        Markup.button.callback(msgs.TgNextBtnMsg, `mail_${queryAddress}_${mailIndex + 1}`, !raw),
                    ])
                },
            );
        }
        return await ctx.reply(mail || msgs.TgNoMailMsg,
            {
                ...Markup.inlineKeyboard([
                    Markup.button.callback(msgs.TgPrevBtnMsg, `mail_${queryAddress}_${mailIndex - 1}`, mailIndex <= 0),
                    ...miniAppButtons,
                    Markup.button.callback(msgs.TgNextBtnMsg, `mail_${queryAddress}_${mailIndex + 1}`, !raw),
                ])
            },
        );
    }

    bot.command("mails", async ctx => {
        const msgs = await getTgMessages(c, ctx);
        try {
            const queryAddress = ctx?.message?.text.slice("/mails".length).trim();
            return await queryMail(ctx, queryAddress, 0, false);
        } catch (e) {
            return await ctx.reply(`${msgs.TgGetMailFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.on(callbackQuery("data"), async ctx => {
        const msgs = await getTgMessages(c, ctx);
        // Use ctx.callbackQuery.data
        try {
            const data = ctx.callbackQuery.data;
            if (data && data.startsWith("mail_") && data.split("_").length === 3) {
                const [_, queryAddress, mailIndex] = data.split("_");
                await queryMail(ctx, queryAddress, parseInt(mailIndex), true);
            }
        }
        catch (e) {
            console.log(`${msgs.TgGetMailFailedMsg} ${(e as Error).message}`, e);
            return await ctx.answerCbQuery(`${msgs.TgGetMailFailedMsg} ${(e as Error).message}`);
        }
        await ctx.answerCbQuery();
    });

    return bot;
}


export async function initTelegramBotCommands(c: Context<HonoCustomType>, bot: Telegraf) {
    await bot.telegram.setMyCommands(getTelegramCommands(c));
}

const parseMail = async (
    msgs: LocaleMessages,
    parsedEmailContext: ParsedEmailContext,
    address: string, created_at: string | undefined | null
) => {
    if (!parsedEmailContext.rawEmail) {
        return {};
    }
    try {
        const parsedEmail = await commonParseMail(parsedEmailContext);
        let parsedText = parsedEmail?.text || "";
        if (parsedText.length && parsedText.length > 1000) {
            parsedText = parsedEmail?.text.substring(0, 1000) + `\n\n...\n${msgs.TgMsgTooLongMsg}`;
        }
        return {
            isHtml: false,
            mail: `From: ${parsedEmail?.sender || msgs.TgNoSenderMsg}\n`
                + `To: ${address}\n`
                + (created_at ? `Date: ${created_at}\n` : "")
                + `Subject: ${parsedEmail?.subject}\n`
                + `Content:\n${parsedText || msgs.TgParseFailedViewInAppMsg}`
        };
    } catch (e) {
        return {
            isHtml: false,
            mail: `${msgs.TgParseMailFailedMsg} ${(e as Error).message}`
        };
    }
}

export async function sendMailToTelegram(
    c: Context<HonoCustomType>, 
    address: string,
    parsedEmailContext: ParsedEmailContext,
    message_id: string | null
) {
    if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.KV) {
        return;
    }
    
    // 获取绑定信息(可能是字符串 userId 或 JSON 对象)
    const bindInfoStr = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:${address}`);
    const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, "json");
    const globalPush = settings?.enableGlobalMailPush && settings?.globalMailPushList;
    
    if (!bindInfoStr && !globalPush) {
        return;
    }
    
    const mailId = await c.env.DB.prepare(
        `SELECT id FROM raw_mails where address = ? and message_id = ?`
    ).bind(address, message_id).first<string>("id");
    const bot = newTelegramBot(c, c.env.TELEGRAM_BOT_TOKEN);

    const buildAndSend = async (
        targetUserId: string, 
        msgs: LocaleMessages,
        targetChatId?: number,
        targetThreadId?: number
    ) => {
        const { mail } = await parseMail(msgs, parsedEmailContext, address, new Date().toUTCString());
        if (!mail) return;
        
        const buttons = [];
        if (settings?.miniAppUrl && mailId) {
            const url = new URL(settings.miniAppUrl);
            url.pathname = "/telegram_mail"
            url.searchParams.set("mail_id", mailId);
            buttons.push(Markup.button.webApp(msgs.TgViewMailBtnMsg, url.toString()));
        }
        
        // 发送到指定聊天或用户
        const sendTo = targetChatId || targetUserId;
        const options: any = {
            ...Markup.inlineKeyboard([...buttons])
        };
        
        // 如果有话题 ID,添加到选项中
        if (targetThreadId) {
            options.message_thread_id = targetThreadId;
        }
        
        await bot.telegram.sendMessage(sendTo, mail, options);
    };

    if (globalPush) {
        const globalMsgs = i18n.getMessages(c.env.DEFAULT_LANG || 'zh');
        for (const pushId of settings.globalMailPushList) {
            await buildAndSend(pushId, globalMsgs);
        }
    }

    if (bindInfoStr) {
        // 尝试解析为 JSON,如果失败则视为旧格式(纯字符串 userId)
        let bindInfo: any;
        try {
            bindInfo = JSON.parse(bindInfoStr);
        } catch {
            // 旧格式:纯字符串 userId
            bindInfo = { userId: bindInfoStr };
        }
        
        const userId = bindInfo.userId || bindInfoStr;
        const userMsgs = await getTgMessages(c, undefined, userId);
        
        await buildAndSend(
            userId,
            userMsgs,
            bindInfo.chatId,
            bindInfo.threadId
        );
    }
}
}
