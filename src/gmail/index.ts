import path from "path";
import { FindUserById, SetToken, FindUserByEmail, SetHistoryId } from "@controller/user";
import { OAuth2Client } from "google-auth-library";
import Express from "express";
import { google, gmail_v1 } from "googleapis";
import { router as pushUpdatesRouter } from "@gmail/pushUpdates";
import { error } from "@service/logging";
import { GaxiosResponse, GaxiosPromise } from "gaxios";

export const router = Express.Router();

router.use(pushUpdatesRouter);

const SCOPES = [ "https://www.googleapis.com/auth/gmail.readonly" ];

export interface IAuthObject { oauth: OAuth2Client; authorized: boolean; }

export interface IMailObject { message: string; attachments: IAttachmentObject[]; }

export interface IAttachmentObject { name: string; data: string; }

export async function authorizeUser(tgID: number): Promise<IAuthObject | null> {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const user = await FindUserById(tgID);
    if (!user) {
        return null;
    }
    try {
        if (user.token === " ") {
            return { oauth: oAuth2Client, authorized: false };
        } else {
            oAuth2Client.setCredentials(JSON.parse(user.token));
            return { oauth: oAuth2Client, authorized: true };
        }
    } catch (e) {
        error(e);
        return null;
    }
}

export function generateUrlToGetToken(oAuth2Client: OAuth2Client) {
    return oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
    });
}

export async function getNewToken(
    tgID: number,
    oAuth2Client: OAuth2Client,
    code: string
): Promise<OAuth2Client | null> {
    return new Promise((resolve) => {
        oAuth2Client.getToken(code, async (err, token) => {
            if (err) {
                error(err);
                return resolve(null);
            }
            oAuth2Client.setCredentials(token);
            try {
                if (!(await SetToken(tgID, JSON.stringify(token)))) {
                    throw new Error("Couldn't write token");
                }
                resolve(oAuth2Client);
            } catch (err) {
                resolve(null);
            }
        });
    });
}

export async function getEmails(emailAdress: string, historyId: number): Promise<false | IMailObject[]> {
    const user = await FindUserByEmail(emailAdress);
    if (!user) {
        return false;
    }
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    if (user.token === " ") {
        error(new Error("Bad token"));
        return false;
    }
    oAuth2Client.setCredentials(JSON.parse(user.token));
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
    let res;
    try {
        res = await asyncListHistory(gmail, user.historyId);
    } catch (e) {
        error(e);
        return false;
    }
    const emailsId: string[] = [];
    for (const r of res) {
        if (r.messagesAdded) {
            r.messagesAdded.forEach((mail) => {
                emailsId.push(mail.message.id);
            });
        }
    }
    console.log("!!!!!!!!!");
    console.log(emailsId);
    console.log("!!!!!!!!!");
    const messagesDocuments = await retriveEmailsFromIds(gmail, emailsId);
    if (!messagesDocuments) {
        return false;
    }
    console.log("@@@@@");
    console.log(JSON.stringify(messagesDocuments));
    console.log("@@@@@");
    const result = [];
    for (const mail of messagesDocuments) {
        const message = Buffer.from(mail.raw, "base64").toString("utf-8");
        const attachments: IAttachmentObject[] = [];
        if (mail.payload && mail.payload.parts) {
            for (const part of mail.payload.parts) {
                if (part.filename) {
                    if (part.body.data) {
                        const data = Buffer.from(part.body.data, "base64").toString("utf-8");
                        attachments.push({ name: part.filename, data });
                    } else {
                        const attId = part.body.attachmentId;
                        const attachment = await retriveAttachment(gmail, mail.id, attId);
                        if (!attachment) {
                            return false;
                        }
                        const data = Buffer.from(attachment.data, "base64").toString("utf-8");
                        attachments.push({ name: part.filename, data });
                    }
                }
            }
        }
        result.push({ message, attachments });
    }
    if (!(await SetHistoryId(user.telegramID, historyId))) {
        return false;
    }
    return result;
}

async function retriveAttachment(gmail: gmail_v1.Gmail, messageId: string, attId: string) {
    let resp;
    try {
        resp = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attId });
        if (resp.status !== 200) {
            throw new Error(resp.statusText);
        }
    } catch (e) {
        error(e);
        return false;
    }
    return resp.data;
}

async function retriveEmailsFromIds(gmail: gmail_v1.Gmail, arr: string[]) {
    const result = [];
    try {
        for (const id of arr) {
            const resp = await gmail.users.messages.get({ userId: "me", id });
            if (resp.status !== 200) {
                throw new Error(resp.statusText);
            }
            result.push(resp.data);
        }
    } catch (e) {
        error(e);
        return false;
    }
    return result;
}

async function asyncListHistory(gmail: gmail_v1.Gmail, startHistoryId: number) {
    return new Promise<gmail_v1.Schema$History[]>((resolve, reject) => {
        listHistory(gmail, startHistoryId, (res, err) => err ? reject(err) : resolve(res));
    });
}

function listHistory(
    gmail: gmail_v1.Gmail,
    startHistoryId: number,
    callback: (res: gmail_v1.Schema$History[], err: Error) => void
) {
    const getPageOfHistory = function(
        request: GaxiosPromise<gmail_v1.Schema$ListHistoryResponse>,
        result: gmail_v1.Schema$History[]
    ) {
        request.then(function(resp) {
            if (resp.status !== 200) {
                callback(null, new Error(resp.statusText));
            }
            result = result.concat(resp.data.history || []);
            const nextPageToken = resp.data.nextPageToken;
            if (nextPageToken) {
                request = gmail.users.history.list({
                    "userId": "me",
                    "startHistoryId": startHistoryId.toString(),
                    "pageToken": nextPageToken
                });
                getPageOfHistory(request, result);
            } else {
                callback(result, null);
            }
        });
    };
    const req = gmail.users.history.list({
        "userId": "me",
        "startHistoryId": startHistoryId.toString()
    });
    getPageOfHistory(req, []);
}
