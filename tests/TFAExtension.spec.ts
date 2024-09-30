import { Blockchain, printTransactionFees, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import {
    Address,
    beginCell,
    Cell,
    Dictionary,
    DictionaryValue,
    internal,
    Sender,
    toNano,
    TransactionComputeVm,
    TransactionDescriptionGeneric,
} from '@ton/core';
import { OpCode, RecoverState, TFAExtension } from '../wrappers/TFAExtension';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed, sign } from '@ton/crypto';
import { Opcodes, WalletV5 } from '../wrappers/WalletV5';
import { ActionSendMsg, ExtendedAction, OutAction, packActionsList } from './wallet/wallet_v5_actions';
import { SendMode } from '@ton/core';
import { deployWallet, linkExtensionToWallet } from './wallet/WalletUtils';
import { JettonMaster, WalletContractV5R1 } from '@ton/ton';
import { MessageRelaxed } from '@ton/core/src/types/MessageRelaxed';
import { Transaction } from '@ton/core';
import { jettonContentToCell, JettonMinter } from '../notcoin-contract/wrappers/JettonMinter';
import * as fs from 'fs';
import { JettonWallet } from '../notcoin-contract/wrappers/JettonWallet';
import { OutActionWalletV5 } from '@ton/ton/dist/wallets/v5beta/WalletV5OutActions';

describe('TFAExtension', () => {
    let code: Cell;
    let walletV5code: Cell;

    beforeAll(async () => {
        code = await compile('TFAExtension');
        walletV5code = await compile('WalletV5');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let tFAExtension: SandboxContract<TFAExtension>;
    let walletV5: SandboxContract<WalletContractV5R1>;

    let serviceKeypair: KeyPair;
    let seedKeypair: KeyPair;
    let deviceKeypairs: KeyPair[];
    let walletKeypair: KeyPair;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');

        serviceKeypair = await randomKeypair();
        seedKeypair = await randomKeypair();
        deviceKeypairs = [await randomKeypair()];
        walletKeypair = await randomKeypair();

        walletV5 = blockchain.openContract(
            WalletContractV5R1.create({
                publicKey: walletKeypair.publicKey,
            }),
        );

        tFAExtension = blockchain.openContract(
            TFAExtension.createFromConfig(
                {
                    wallet: walletV5.address,
                },
                code,
            ),
        );

        await deployer.send({
            value: toNano('1000'),
            to: walletV5.address,
            bounce: false,
        });

        await linkExtension();

        const sender = (await walletV5.sender(walletKeypair.secretKey)).result;
        const deployResult = await tFAExtension.sendDeploy(sender, toNano('1.5'), {
            servicePubkey: bufferToBigInt(serviceKeypair.publicKey),
            seedPubkey: bufferToBigInt(seedKeypair.publicKey),
            devicePubkeys: keysToDict(deviceKeypairs),
        });

        expect(deployResult.transactions).toHaveTransaction({
            from: walletV5.address,
            to: tFAExtension.address,
            deploy: true,
            success: true,
        });
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(false);
    });

    async function linkExtension() {
        await walletV5.sendAddExtension({
            authType: 'external',
            seqno: await walletV5.getSeqno(),
            secretKey: walletKeypair.secretKey,
            extensionAddress: tFAExtension.address,
        });
    }

    it('should deploy', async () => {
        expect(await tFAExtension.getSeqno()).toEqual(1);
        expect(await tFAExtension.getWalletAddr()).toEqualAddress(walletV5.address);
        expect(await tFAExtension.getServicePubkey()).toEqual(bufferToBigInt(serviceKeypair.publicKey));
        expect(await tFAExtension.getSeedPubkey()).toEqual(bufferToBigInt(seedKeypair.publicKey));
        expect(await tFAExtension.getDevicePubkey(0)).toEqual(bufferToBigInt(deviceKeypairs[0].publicKey));
        const recoverState = await tFAExtension.getRecoverState();
        expect(recoverState.type).toEqual('none');
    });

    async function shouldFail(f: Promise<any>) {
        try {
            await f;
        } catch (e) {
            return;
        }
        throw new Error('Expected to fail');
    }

    it('should test shouldFail function', async () => {
        async function throwable() {
            throw new Error('Expected to fail');
        }
        async function notThrowable() {}

        await expect(shouldFail(notThrowable())).rejects.toThrow(new Error('Expected to fail'));

        await expect(shouldFail(throwable())).resolves.toEqual(undefined);
    });

    describe('sendSendActions', () => {
        async function testSendActions(
            prefix: string,
            opts: {
                servicePrivateKey?: Buffer;
                devicePrivateKey?: Buffer;
                deviceId?: number;
                actions: OutActionWalletV5[];
                refill?: boolean;
                logGasUsage?: boolean;
            },
        ) {
            let {
                servicePrivateKey = serviceKeypair.secretKey,
                devicePrivateKey = deviceKeypairs[0].secretKey,
                deviceId = 0,
                actions = [],
                refill = false,
                logGasUsage = false,
            } = opts;
            const originalActions = actions.slice();
            if (refill) {
                actions.unshift({
                    type: 'sendMsg',
                    mode: SendMode.PAY_GAS_SEPARATELY,
                    outMsg: internal({
                        to: tFAExtension.address,
                        value: toNano('1'),
                    }),
                });
            }

            const request = walletV5.createRequest({
                seqno: await walletV5.getSeqno(),
                authType: 'extension',
                actions,
            });
            const res1 = await tFAExtension.sendSendActions({
                servicePrivateKey: servicePrivateKey,
                devicePrivateKey: devicePrivateKey,
                deviceId,
                seqno: await tFAExtension.getSeqno(),
                actionsList: request,
            });

            let s = '';
            if (logGasUsage) {
                let gasUsed = (
                    (res1.transactions[0].description as TransactionDescriptionGeneric)
                        .computePhase as TransactionComputeVm
                ).gasUsed;
                s += `[${prefix}] GAS USED: ${gasUsed}\n`;
            }

            if (logGasUsage) {
                const walletV5_2_keypair = await randomKeypair();
                const walletV5_2 = blockchain.openContract(
                    WalletContractV5R1.create({
                        publicKey: walletV5_2_keypair.publicKey,
                    }),
                );
                await deployer.send({
                    value: toNano('1000'),
                    to: walletV5_2.address,
                    bounce: false,
                });
                await walletV5_2.sendTransfer({
                    seqno: await walletV5_2.getSeqno(),
                    secretKey: walletV5_2_keypair.secretKey,
                    authType: 'external',
                    messages: [],
                    sendMode: SendMode.NONE,
                });

                const request2 = walletV5_2.createRequest({
                    seqno: await walletV5_2.getSeqno(),
                    secretKey: walletV5_2_keypair.secretKey,
                    authType: 'external',
                    actions: originalActions,
                });
                const resSimple = await walletV5_2.send(request2);

                const totalFeesSimple = resSimple.transactions.reduce((acc, tx) => acc + tx.totalFees.coins, 0n);
                const totalFees = res1.transactions.reduce((acc, tx) => acc + tx.totalFees.coins, 0n);

                s += `[${prefix}][no 2FA] Total fees: ${Number(totalFeesSimple) / 1000000000}\n`;
                s += `[${prefix}][   2FA] Total fees: ${Number(totalFees) / 1000000000}\n`;
                s += `[${prefix}] increase: ${(Number(totalFees) / Number(totalFeesSimple)).toFixed(2)}x\n`;
                console.log(s);
            }

            return res1;
        }

        it('should send actions (no refill)', async () => {
            const res = await testSendActions('Simple Transfer', {
                actions: [
                    {
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY,
                        outMsg: internal({
                            to: deployer.address,
                            value: toNano('0.1'),
                        }),
                    },
                ],
                refill: false,
                logGasUsage: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: walletV5.address,
                to: deployer.address,
                value: toNano('0.1'),
                success: true,
            });
        });

        it('should send actions (refill)', async () => {
            const res = await testSendActions('Transfer & Refill', {
                actions: [
                    {
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY,
                        outMsg: internal({
                            to: deployer.address,
                            value: toNano('0.1'),
                        }),
                    },
                ],
                refill: true,
                logGasUsage: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: walletV5.address,
                to: tFAExtension.address,
                value: toNano('1.0'),
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: walletV5.address,
                to: deployer.address,
                value: toNano('0.1'),
                success: true,
            });
        });

        it('should not send actions with wrong servicePrivateKey', async () => {
            await shouldFail(
                testSendActions('Wrong Service Private Key', {
                    servicePrivateKey: (await randomKeypair()).secretKey,
                    actions: [],
                }),
            );
        });

        it('should not send actions with wrong devicePrivateKey', async () => {
            await shouldFail(
                testSendActions('Wrong Device Private Key', {
                    devicePrivateKey: (await randomKeypair()).secretKey,
                    actions: [],
                }),
            );
        });

        it('should not send actions with wrong deviceId', async () => {
            await shouldFail(
                testSendActions('Wrong Device Id', {
                    deviceId: 1,
                    actions: [],
                }),
            );
        });
    });

    describe('authorizeDevice', () => {
        async function authorizeDeviceTest(opts: {
            servicePrivateKey?: Buffer;
            devicePrivateKey?: Buffer;
            deviceId?: number;
            newDevicePubkey?: Buffer;
            newDeviceId?: number;
        }): Promise<[SendMessageResult, Buffer]> {
            let {
                servicePrivateKey = serviceKeypair.secretKey,
                devicePrivateKey = deviceKeypairs[0].secretKey,
                deviceId = 0,
                newDevicePubkey = null,
                newDeviceId = 1,
            } = opts;

            if (newDevicePubkey === null) {
                newDevicePubkey = (await randomKeypair()).publicKey;
            }

            const res = await tFAExtension.sendAuthorizeDevice({
                servicePrivateKey,
                devicePrivateKey,
                deviceId,
                seqno: await tFAExtension.getSeqno(),
                newDevicePubkey: bufferToBigInt(newDevicePubkey),
                newDeviceId,
            });

            return [res, newDevicePubkey];
        }

        it('should authorize devices', async () => {
            const [res, newDevicePubkey] = await authorizeDeviceTest({});

            expect(res.transactions).toHaveTransaction({
                to: tFAExtension.address,
                success: true,
            });
            expect(await tFAExtension.getDevicePubkey(1)).toEqual(bufferToBigInt(newDevicePubkey));
            expect(await tFAExtension.getSeqno()).toEqual(2);
        });

        it('should not authorize devices with wrong servicePrivateKey', async () => {
            const randomNewKeypair = await randomKeypair();
            await shouldFail(authorizeDeviceTest({ servicePrivateKey: randomNewKeypair.secretKey }));
        });

        it('should not authorize devices with wrong devicePrivateKey', async () => {
            const randomNewKeypair = await randomKeypair();
            await shouldFail(authorizeDeviceTest({ devicePrivateKey: randomNewKeypair.secretKey }));
        });

        it('should not authorize devices with wrong deviceId', async () => {
            await shouldFail(authorizeDeviceTest({ deviceId: 1 }));
        });

        it('should not authorize devices with existing newDeviceId', async () => {
            await shouldFail(authorizeDeviceTest({ newDeviceId: 0 }));
        });

        it('should not authorize device if recover process is started', async () => {
            await tFAExtension.sendRecoverAccess({
                servicePrivateKey: serviceKeypair.secretKey,
                seedPrivateKey: seedKeypair.secretKey,
                seqno: 1,
                newDevicePubkey: bufferToBigInt(deviceKeypairs[0].publicKey),
                newDeviceId: 1,
            });

            await shouldFail(authorizeDeviceTest({}));
        });
    });

    describe('unauthorizeDevice', () => {
        async function unauthorizeDeviceTest(opts: {
            servicePrivateKey?: Buffer;
            devicePrivateKey?: Buffer;
            deviceId?: number;
            removeDeviceId?: number;
        }): Promise<SendMessageResult> {
            let {
                servicePrivateKey = serviceKeypair.secretKey,
                devicePrivateKey = deviceKeypairs[0].secretKey,
                deviceId = 0,
                removeDeviceId = 0,
            } = opts;

            const res = await tFAExtension.sendUnauthorizeDevice({
                servicePrivateKey,
                devicePrivateKey,
                deviceId,
                seqno: await tFAExtension.getSeqno(),
                removeDeviceId,
            });

            return res;
        }
        it('should unauthorize devices', async () => {
            const res = await unauthorizeDeviceTest({});

            expect(res.transactions).toHaveTransaction({
                to: tFAExtension.address,
                success: true,
            });

            const pubkeys: Dictionary<number, bigint> = await tFAExtension.getDevicePubkeys();

            expect(pubkeys.keys().length).toEqual(0);
        });

        it('should not unauthorize devices with wrong servicePrivateKey', async () => {
            const randomNewKeypair = await randomKeypair();
            await shouldFail(unauthorizeDeviceTest({ servicePrivateKey: randomNewKeypair.secretKey }));
        });

        it('should not unauthorize devices with wrong devicePrivateKey', async () => {
            const randomNewKeypair = await randomKeypair();
            await shouldFail(unauthorizeDeviceTest({ devicePrivateKey: randomNewKeypair.secretKey }));
        });

        it('should not unauthorize devices with wrong deviceId', async () => {
            await shouldFail(unauthorizeDeviceTest({ deviceId: 1 }));
        });

        it('should not unauthorize devices with wrong removeDeviceId', async () => {
            await shouldFail(unauthorizeDeviceTest({ removeDeviceId: 1 }));
        });

        it('should not unauthorize device if recover process is started', async () => {
            await tFAExtension.sendRecoverAccess({
                servicePrivateKey: serviceKeypair.secretKey,
                seedPrivateKey: seedKeypair.secretKey,
                seqno: 1,
                newDevicePubkey: bufferToBigInt(deviceKeypairs[0].publicKey),
                newDeviceId: 1,
            });

            await shouldFail(unauthorizeDeviceTest({}));
        });
    });

    describe('destruct', () => {
        async function destructTest(opts: {
            servicePrivateKey?: Buffer;
            devicePrivateKey?: Buffer;
            deviceId?: number;
        }): Promise<SendMessageResult> {
            let {
                servicePrivateKey = serviceKeypair.secretKey,
                devicePrivateKey = deviceKeypairs[0].secretKey,
                deviceId = 0,
            } = opts;

            const res = await tFAExtension.sendDestruct({
                servicePrivateKey,
                devicePrivateKey,
                deviceId,
                seqno: await tFAExtension.getSeqno(),
            });

            return res;
        }

        it('should destruct', async () => {
            const res = await destructTest({});

            expect(res.transactions).toHaveTransaction({
                to: tFAExtension.address,
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: tFAExtension.address,
                to: walletV5.address,
                success: true,
                exitCode: 0,
            });

            let tfa_state = await blockchain.getContract(tFAExtension.address);
            expect(tfa_state.accountState).toEqual(undefined);

            expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(true);
            expect(await walletV5.getExtensionsArray()).toEqual([]);
        });

        it('should not destruct with wrong servicePrivateKey', async () => {
            const randomNewKeypair = await randomKeypair();
            await shouldFail(destructTest({ servicePrivateKey: randomNewKeypair.secretKey }));
        });

        it('should not destruct with wrong devicePrivateKey', async () => {
            const randomNewKeypair = await randomKeypair();
            await shouldFail(destructTest({ devicePrivateKey: randomNewKeypair.secretKey }));
        });

        it('should not destruct with wrong deviceId', async () => {
            await shouldFail(destructTest({ deviceId: 1 }));
        });

        it('should not destruct device if recover process is started', async () => {
            await tFAExtension.sendRecoverAccess({
                servicePrivateKey: serviceKeypair.secretKey,
                seedPrivateKey: seedKeypair.secretKey,
                seqno: 1,
                newDevicePubkey: bufferToBigInt(deviceKeypairs[0].publicKey),
                newDeviceId: 1,
            });

            await shouldFail(destructTest({}));
        });
    });

    it('should recover access', async () => {
        const newDeviceKeypair = await randomKeypair();
        blockchain.now = Math.floor(Date.now() / 1000);

        // ------ STEP 1 ------
        const res = await tFAExtension.sendRecoverAccess({
            servicePrivateKey: serviceKeypair.secretKey,
            seedPrivateKey: seedKeypair.secretKey,
            seqno: 1,
            newDevicePubkey: bufferToBigInt(newDeviceKeypair.publicKey),
            newDeviceId: 1,
        });

        expect(res.transactions).toHaveTransaction({
            to: tFAExtension.address,
            success: true,
        });
        let state: RecoverState = await tFAExtension.getRecoverState();
        if (state.type === 'requested') {
            expect(state.newDeviceId).toEqual(1);
            expect(state.newDevicePubkey).toEqual(bufferToBigInt(newDeviceKeypair.publicKey));
        } else {
            fail('Expected requested state');
        }

        // ------ STEP 2 ------
        blockchain.now += 60 * 60 * 24 * 3;

        const res2 = await tFAExtension.sendRecoverAccess({
            servicePrivateKey: serviceKeypair.secretKey,
            seedPrivateKey: seedKeypair.secretKey,
            seqno: 2,
            newDevicePubkey: bufferToBigInt(newDeviceKeypair.publicKey),
            validUntil: blockchain.now + 180,
            newDeviceId: 1,
        });

        expect(res2.transactions).toHaveTransaction({
            to: tFAExtension.address,
            success: true,
        });

        state = await tFAExtension.getRecoverState();
        expect(state.type).toEqual('none');

        expect(await tFAExtension.getDevicePubkey(1)).toEqual(bufferToBigInt(newDeviceKeypair.publicKey));
    });

    it('should cancel recover access', async () => {
        const newDeviceKeypair = await randomKeypair();
        blockchain.now = Math.floor(Date.now() / 1000);

        // ------ STEP 1 ------
        const res = await tFAExtension.sendRecoverAccess({
            servicePrivateKey: serviceKeypair.secretKey,
            seedPrivateKey: seedKeypair.secretKey,
            seqno: 1,
            newDevicePubkey: bufferToBigInt(newDeviceKeypair.publicKey),
            newDeviceId: 1,
        });

        expect(res.transactions).toHaveTransaction({
            to: tFAExtension.address,
            success: true,
        });
        let state: RecoverState = await tFAExtension.getRecoverState();
        if (state.type === 'requested') {
            expect(state.newDeviceId).toEqual(1);
            expect(state.newDevicePubkey).toEqual(bufferToBigInt(newDeviceKeypair.publicKey));
        } else {
            fail('Expected requested state');
        }

        // ------ STEP 2 ------
        const res2 = await tFAExtension.sendCancelRequest({
            servicePrivateKey: serviceKeypair.secretKey,
            seedPrivateKey: seedKeypair.secretKey,
            seqno: 2,
        });

        expect(res2.transactions).toHaveTransaction({
            to: tFAExtension.address,
            success: true,
        });

        state = await tFAExtension.getRecoverState();
        expect(state.type).toEqual('none');
    });

    it('test transfer tokens fees', async () => {
        // ------ PREPARE JETTONS ------
        const minter_code = loadNotcoinCode('./notcoin-contract/build/JettonMinter.compiled.json');
        const jwallet_code_raw = loadNotcoinCode('./notcoin-contract/build/JettonWallet.compiled.json');

        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${jwallet_code_raw.hash().toString('hex')}`), jwallet_code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;
        let lib_prep = beginCell().storeUint(2, 8).storeBuffer(jwallet_code_raw.hash()).endCell();
        const jwallet_code = new Cell({ exotic: true, bits: lib_prep.bits, refs: lib_prep.refs });

        const jettonMinter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: deployer.address,
                    wallet_code: jwallet_code,
                    jetton_content: beginCell().endCell(),
                },
                minter_code,
            ),
        );
        await jettonMinter.sendDeploy(deployer.getSender(), toNano('10'));

        const walletV5JettonWallet = blockchain.openContract(
            JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(walletV5.address)),
        );

        await jettonMinter.sendMint(deployer.getSender(), walletV5.address, toNano('1000'));

        expect(await walletV5JettonWallet.getJettonBalance()).toEqual(toNano('1000'));

        let extensionSeqno = 1;
        async function test(receiver1: Address, receiver2: Address) {
            // ------ SEND TO EXTENSION ------
            const actions = walletV5.createRequest({
                seqno: 2,
                authType: 'extension',
                actions: [
                    {
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY,
                        outMsg: internal({
                            to: walletV5JettonWallet.address,
                            value: toNano('0.15'),
                            body: JettonWallet.transferMessage(
                                toNano('100'),
                                receiver1,
                                walletV5.address,
                                null,
                                1n,
                                beginCell().storeUint(10, 32).endCell(),
                            ),
                        }),
                    },
                ],
            });
            const res = await tFAExtension.sendSendActions({
                servicePrivateKey: serviceKeypair.secretKey,
                devicePrivateKey: deviceKeypairs[0].secretKey,
                deviceId: 0,
                seqno: 1,
                actionsList: actions,
            });

            {
                const walletV5_2_keypair = await randomKeypair();
                const walletV5_2 = blockchain.openContract(
                    WalletContractV5R1.create({
                        publicKey: walletV5_2_keypair.publicKey,
                    }),
                );
                await deployer.send({
                    value: toNano('1000'),
                    to: walletV5_2.address,
                    bounce: false,
                });
                await walletV5_2.sendTransfer({
                    seqno: await walletV5_2.getSeqno(),
                    secretKey: walletV5_2_keypair.secretKey,
                    authType: 'external',
                    messages: [],
                    sendMode: SendMode.NONE,
                });
                await jettonMinter.sendMint(deployer.getSender(), walletV5_2.address, toNano('1000'));

                const walletV5_2JettonWallet = blockchain.openContract(
                    JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(walletV5_2.address)),
                );

                const actions = walletV5_2.createRequest({
                    seqno: await walletV5_2.getSeqno(),
                    secretKey: walletV5_2_keypair.secretKey,
                    authType: 'external',
                    actions: [
                        {
                            type: 'sendMsg',
                            mode: SendMode.PAY_GAS_SEPARATELY,
                            outMsg: internal({
                                to: walletV5_2JettonWallet.address,
                                value: toNano('0.1'),
                                body: JettonWallet.transferMessage(
                                    toNano('100'),
                                    receiver2,
                                    walletV5_2.address,
                                    null,
                                    1n,
                                    beginCell().storeUint(10, 32).endCell(),
                                ),
                            }),
                        },
                    ],
                });
                const resSimple = await walletV5_2.send(actions);
                const totalFeesSimple = resSimple.transactions.reduce((acc, tx) => acc + tx.totalFees.coins, 0n);
                const totalFees = res.transactions.reduce((acc, tx) => acc + tx.totalFees.coins, 0n);

                let s = `[Token][no 2FA] Total fees: ${Number(totalFeesSimple) / 1000000000}\n`;
                s += `[Token][   2FA] Total fees: ${Number(totalFees) / 1000000000}\n`;
                s += `[Token] increase: ${(Number(totalFees) / Number(totalFeesSimple)).toFixed(2)}x\n`;
                console.log(s);
            }
        }

        const receiver1 = await blockchain.treasury('receiver1');
        const receiver2 = await blockchain.treasury('receiver2');

        await test(receiver1.address, receiver2.address);
    });
});

function loadNotcoinCode(path: string): Cell {
    // load file content as json

    const fileContent = fs.readFileSync(path, 'utf8');
    const json = JSON.parse(fileContent);
    const hex: string = json.hex;

    return Cell.fromBoc(Buffer.from(hex, 'hex'))[0];
}

function keysToDict(keys: KeyPair[]): Dictionary<number, bigint> {
    return keys.reduce(
        (dict, key, index) => dict.set(index, bufferToBigInt(key.publicKey)),
        Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.BigUint(256)),
    );
}

function bufferToBigInt(buffer: Buffer) {
    const bufferAsHexString = buffer.toString('hex');
    return BigInt(`0x${bufferAsHexString}`);
}

async function randomKeypair() {
    return keyPairFromSeed(await getSecureRandomBytes(32));
}
