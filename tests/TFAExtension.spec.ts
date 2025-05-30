import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import {
    Address,
    beginCell,
    Cell,
    Dictionary,
    internal,
    storeMessageRelaxed,
    toNano,
    TransactionComputeVm,
    TransactionDescriptionGeneric,
} from '@ton/core';
import { Certificate, TFAExtension } from '../wrappers/TFAExtension';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed, sign } from '@ton/crypto';
import { SendMode } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { JettonMinter } from '../notcoin-contract/wrappers/JettonMinter';
import * as fs from 'fs';
import { JettonWallet } from '../notcoin-contract/wrappers/JettonWallet';
import { OutActionWalletV5 } from '@ton/ton/dist/wallets/v5beta/WalletV5OutActions';
import { randomAddress } from '@ton/test-utils';
import { TFAMaster } from '../wrappers/TFAMaster';

describe('TFAExtension', () => {
    let code: Cell;
    let masterCode: Cell;

    beforeAll(async () => {
        code = await compile('TFAExtension');
        masterCode = await compile('TFAMaster');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let tFAExtension: SandboxContract<TFAExtension>;
    let walletV5: SandboxContract<WalletContractV5R1>;
    let tFAMaster: SandboxContract<TFAMaster>;

    let rootCAKeypair: KeyPair;
    let certificate: Certificate;
    let seedKeypair: KeyPair;
    let walletKeypair: KeyPair;

    let firstInstall = true;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');

        rootCAKeypair = await randomKeypair();
        certificate = await makeCertificate({ rootCAKeypair });

        seedKeypair = await randomKeypair();
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
            rootCAPubkey: bufferToBigInt(rootCAKeypair.publicKey),
            seedPubkey: bufferToBigInt(seedKeypair.publicKey),
        });

        expect(deployResult.transactions).toHaveTransaction({
            from: walletV5.address,
            to: tFAExtension.address,
            deploy: true,
            success: true,
        });
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(false);

        if (firstInstall) {
            firstInstall = false;

            let gasUsed = (
                (deployResult.transactions[2].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).gasUsed;

            console.log(`GAS USED WHEN INSTALLING EXTENSION ON WALLET: ${gasUsed}\n`);
        }

        tFAMaster = blockchain.openContract(TFAMaster.createFromConfig({}, masterCode));
        await tFAMaster.sendDeploy(deployer.getSender(), toNano('0.01'));
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
        expect(await tFAExtension.getRootPubkey()).toEqual(bufferToBigInt(rootCAKeypair.publicKey));
        expect(await tFAExtension.getSeedPubkey()).toEqual(bufferToBigInt(seedKeypair.publicKey));
        const delegationState = await tFAExtension.getDelegationState();
        expect(delegationState.type).toEqual('none');
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
                cert?: Certificate;
                seedPrivateKey?: Buffer;
                actions: OutActionWalletV5[];
                refill?: boolean;
                logGasUsage?: boolean;
                validUntil?: number;
                seqno?: number;
                external?: boolean;
            },
        ) {
            let {
                cert = certificate,
                seedPrivateKey = seedKeypair.secretKey,
                actions = [],
                refill = false,
                logGasUsage = false,
                validUntil = Math.floor(Date.now() / 1000) + 180,
                seqno = await tFAExtension.getSeqno(),
                external = true,
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
            const msgPre = internal({
                to: walletV5.address,
                value: toNano('0.1'),
                body: request,
            });
            const txFees = await tFAExtension.getEstimatedAttachedValue({
                forwardMsg: beginCell().store(storeMessageRelaxed(msgPre)).endCell(),
                outputMsgCount: actions.length,
                extendedActionCount: 0,
            });
            let msg = internal({
                to: walletV5.address,
                value: txFees,
                body: request,
            });
            let res1: SendMessageResult;

            if (external) {
                res1 = await tFAExtension.sendSendActions({
                    certificate: cert,
                    seedPrivateKey: seedPrivateKey,
                    seqno,
                    validUntil,
                    msg: beginCell().store(storeMessageRelaxed(msg)).endCell(),
                    sendMode: SendMode.NONE,
                });
            } else {
                res1 = await tFAExtension.sendInternalSendActions(deployer.getSender(), toNano('0.05'), {
                    certificate: cert,
                    seedPrivateKey: seedPrivateKey,
                    seqno,
                    validUntil,
                    msg: beginCell().store(storeMessageRelaxed(msg)).endCell(),
                    sendMode: SendMode.NONE,
                });
            }

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

                const expectedFeesByMaster = await tFAMaster.getEstimatedFeesOnSendActions({
                    forwardMsg: beginCell().store(storeMessageRelaxed(msg)).endCell(),
                    outputMsgCount: actions.length,
                    extendedActionCount: 0,
                });

                s += `[${prefix}][no 2FA] Total fees: ${Number(totalFeesSimple) / 1000000000}\n`;
                s += `[${prefix}][   2FA] Total fees: ${Number(totalFees) / 1000000000}\n`;
                s += `[${prefix}] increase: ${(Number(totalFees) / Number(totalFeesSimple)).toFixed(2)}x\n`;
                s += `[${prefix}][ Debug] Calculated: ${Number(expectedFeesByMaster) / 1000000000}\n`;
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

        it('should send actions (internal)', async () => {
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
                external: false,
            });

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: tFAExtension.address,
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: walletV5.address,
                to: deployer.address,
                value: toNano('0.1'),
                success: true,
            });
        });

        it('should not send actions with wrong certificate', async () => {
            await shouldFail(
                testSendActions('Wrong Certificate Signature', {
                    cert: {
                        ...certificate,
                        keypair: await randomKeypair(),
                    },
                    actions: [],
                }),
            );
        });

        it('should not send actions with expired certificate', async () => {
            await shouldFail(
                testSendActions('Expired Certificate', {
                    cert: await makeCertificate({ rootCAKeypair, validUntil: Math.floor(Date.now() / 1000) - 1 }),
                    actions: [],
                }),
            );
        });

        it('should not send actions with wrong seedPrivateKey', async () => {
            await shouldFail(
                testSendActions('Wrong Device Private Key', {
                    seedPrivateKey: (await randomKeypair()).secretKey,
                    actions: [],
                }),
            );
        });

        it('should not send actions with wrong validUntil', async () => {
            await shouldFail(
                testSendActions('Wrong Valid Until', {
                    actions: [],
                    validUntil: Math.floor(Date.now() / 1000) - 1,
                }),
            );
        });

        it('should not send actions with wrong seqno', async () => {
            await shouldFail(
                testSendActions('Wrong Seqno', {
                    actions: [],
                    seqno: 0,
                }),
            );
        });

        it('should not send actions if delegation is started', async () => {
            await tFAExtension.sendDelegation({
                seedPrivateKey: seedKeypair.secretKey,
                seqno: 1,
                newStateInit: beginCell().endCell(),
                forwardAmount: toNano('0.3'),
            });

            await shouldFail(
                testSendActions('Recover Process Started', {
                    actions: [],
                }),
            );
        });
    });

    describe('remove extension', () => {
        async function destructTest(opts: {
            cert?: Certificate;
            seedPrivateKey?: Buffer;
            validUntil?: number;
            seqno?: number;
        }): Promise<SendMessageResult> {
            let {
                cert = certificate,
                seedPrivateKey = seedKeypair.secretKey,
                validUntil = Math.floor(Date.now() / 1000) + 180,
                seqno = await tFAExtension.getSeqno(),
            } = opts;

            const res = await tFAExtension.sendRemoveExtension({
                certificate: cert,
                seedPrivateKey,
                seqno,
                validUntil,
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

            let confirmationGasUsed = (
                (res.transactions[2].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm
            ).gasUsed;

            expect(confirmationGasUsed).toEqual(3042n);
        });

        it('should not destruct with wrong certificate', async () => {
            await shouldFail(destructTest({ cert: { ...certificate, keypair: await randomKeypair() } }));
        });

        it('should not destruct with wrong seedPrivateKey', async () => {
            const randomNewKeypair = await randomKeypair();
            await shouldFail(destructTest({ seedPrivateKey: randomNewKeypair.secretKey }));
        });

        it('should not destruct with wrong validUntil', async () => {
            await shouldFail(destructTest({ validUntil: Math.floor(Date.now() / 1000) - 1 }));
        });

        it('should not destruct with wrong seqno', async () => {
            await shouldFail(destructTest({ seqno: 0 }));
        });

        it('should not destruct if delegation is started', async () => {
            await tFAExtension.sendDelegation({
                seedPrivateKey: seedKeypair.secretKey,
                seqno: 1,
                newStateInit: beginCell().endCell(),
                forwardAmount: toNano('0.3'),
            });

            await shouldFail(destructTest({}));
        });
    });

    describe('delegation', () => {
        let newWalletKeypair: KeyPair;
        let newWallet: WalletContractV5R1;
        let newWalletStateInit: Cell;

        beforeEach(async () => {
            newWalletKeypair = await randomKeypair();
            newWallet = WalletContractV5R1.create({
                publicKey: newWalletKeypair.publicKey,
            });
            newWalletStateInit = beginCell()
                .storeUint(0, 2)
                .storeMaybeRef(newWallet.init.code)
                .storeMaybeRef(newWallet.init.data)
                .storeUint(0, 1)
                .endCell();
        });

        async function delegationTest(opts: {
            newStateInit?: Cell;
            forwardAmount?: bigint;
            seedPrivateKey?: Buffer;
            validUntil?: number;
            seqno?: number;
        }): Promise<SendMessageResult> {
            let {
                seedPrivateKey = seedKeypair.secretKey,
                validUntil = Math.floor(Date.now() / 1000) + 180,
                seqno = await tFAExtension.getSeqno(),
                newStateInit = newWalletStateInit,
                forwardAmount = toNano('0.3'),
            } = opts;

            const res = await tFAExtension.sendDelegation({
                seedPrivateKey,
                seqno,
                validUntil,
                newStateInit,
                forwardAmount,
            });

            return res;
        }

        async function cancelTest(opts: {
            seedPrivateKey?: Buffer;
            seqno?: number;
            validUntil?: number;
        }): Promise<SendMessageResult> {
            let {
                seedPrivateKey = seedKeypair.secretKey,
                seqno = await tFAExtension.getSeqno(),
                validUntil = Math.floor(Date.now() / 1000) + 180,
            } = opts;

            const res = await tFAExtension.sendCancelDelegation({
                seedPrivateKey,
                seqno,
                validUntil,
            });

            return res;
        }

        it('should delegate', async () => {
            blockchain.now = Math.floor(Date.now() / 1000);
            const res = await delegationTest({});

            // STEP 1
            expect(res.transactions).toHaveTransaction({
                to: tFAExtension.address,
                success: true,
            });

            const state = await tFAExtension.getDelegationState();
            if (state.type === 'delegation') {
                expect(state.newStateInit).toEqualCell(newWalletStateInit);
                expect(state.forwardAmount).toEqual(toNano('0.3'));
            } else {
                fail('Expected disabling state');
            }

            // STEP 2
            blockchain.now = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14;
            const res2 = await delegationTest({ validUntil: blockchain.now + 180 });

            expect(res2.transactions).toHaveTransaction({
                to: tFAExtension.address,
                success: true,
            });

            expect(res2.transactions).toHaveTransaction({
                from: tFAExtension.address,
                to: walletV5.address,
                success: true,
            });

            let walletState = await blockchain.getContract(newWallet.address);
            expect(walletState.accountState?.type).toEqual('active');

            let tfaState = await blockchain.getContract(tFAExtension.address);
            expect(tfaState.accountState).toEqual(undefined);

            let extensions: Address[] = await walletV5.getExtensionsArray();

            expect(extensions[0]).toEqualAddress(newWallet.address);
            expect(extensions.length).toEqual(1);
        });

        it('should cancel disabling', async () => {
            blockchain.now = Math.floor(Date.now() / 1000);

            // STEP 1
            await delegationTest({});

            // STEP 2
            const res2 = await cancelTest({});

            expect(res2.transactions).toHaveTransaction({
                to: tFAExtension.address,
                success: true,
            });

            let state = await tFAExtension.getDelegationState();
            expect(state.type).toEqual('none');
        });

        it('should not disable if seedPrivateKey is wrong', async () => {
            await shouldFail(delegationTest({ seedPrivateKey: (await randomKeypair()).secretKey }));
        });

        it('should not disable if seqno is wrong', async () => {
            await shouldFail(delegationTest({ seqno: 0 }));
        });

        it('should not disable if validUntil is wrong', async () => {
            await shouldFail(delegationTest({ validUntil: Math.floor(Date.now() / 1000) - 1 }));
        });

        it('should not disable if state init is wrong on step 2', async () => {
            // STEP 1
            blockchain.now = Math.floor(Date.now() / 1000);
            await delegationTest({});

            // STEP 2
            blockchain.now = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3;
            await shouldFail(delegationTest({ newStateInit: beginCell().storeUint(0, 2).endCell() }));
        });

        it('should not disable if forwardAmount is wrong on step 2', async () => {
            // STEP 1
            blockchain.now = Math.floor(Date.now() / 1000);
            await delegationTest({});

            // STEP 2
            blockchain.now = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3;
            await shouldFail(delegationTest({ forwardAmount: toNano('0.4') }));
        });

        it('should not cancel if disabling is not started', async () => {
            await shouldFail(cancelTest({}));
        });

        it('should not cancel if seedPrivateKey is wrong', async () => {
            // STEP 1
            blockchain.now = Math.floor(Date.now() / 1000);
            await delegationTest({});

            await shouldFail(cancelTest({ seedPrivateKey: (await randomKeypair()).secretKey }));
        });

        it('should not cancel if seqno is wrong', async () => {
            // STEP 1
            blockchain.now = Math.floor(Date.now() / 1000);
            await delegationTest({});

            await shouldFail(cancelTest({ seqno: 0 }));
        });

        it('should not cancel if validUntil is wrong', async () => {
            // STEP 1
            blockchain.now = Math.floor(Date.now() / 1000);
            await delegationTest({});

            await shouldFail(cancelTest({ validUntil: Math.floor(Date.now() / 1000) - 3 }));
        });
    });

    async function createJettonMinter() {
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

        return jettonMinter;
    }

    it('test transfer tokens fees', async () => {
        const jettonMinter = await createJettonMinter();

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

            const msgPre = internal({
                to: walletV5.address,
                value: toNano('0.1'),
                body: actions,
            });
            const txFees = await tFAExtension.getEstimatedAttachedValue({
                forwardMsg: beginCell().store(storeMessageRelaxed(msgPre)).endCell(),
                outputMsgCount: 1,
                extendedActionCount: 0,
            });
            let msg = internal({
                to: walletV5.address,
                value: txFees,
                body: actions,
            });

            const res = await tFAExtension.sendSendActions({
                certificate: certificate,
                seedPrivateKey: seedKeypair.secretKey,
                seqno: 1,
                msg: beginCell().store(storeMessageRelaxed(msg)).endCell(),
                sendMode: SendMode.NONE,
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

    it('test 255 transfer tokens fees', async () => {
        const jettonMinter = await createJettonMinter();

        const walletV5JettonWallet = blockchain.openContract(
            JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(walletV5.address)),
        );

        await jettonMinter.sendMint(deployer.getSender(), walletV5.address, toNano('1000'));

        expect(await walletV5JettonWallet.getJettonBalance()).toEqual(toNano('1000'));

        const actionsList: OutActionWalletV5[] = [];
        for (let i = 0; i < 50; i++) {
            actionsList.push({
                type: 'sendMsg',
                mode: SendMode.PAY_GAS_SEPARATELY,
                outMsg: internal({
                    to: walletV5JettonWallet.address,
                    value: toNano('0.15') + BigInt(i),
                    body: JettonWallet.transferMessage(
                        toNano('1'),
                        randomAddress(),
                        walletV5.address,
                        null,
                        1n,
                        beginCell().storeUint(10, 32).endCell(),
                    ),
                }),
            });
        }

        // ------ SEND TO EXTENSION ------
        const actions = walletV5.createRequest({
            seqno: 2,
            authType: 'extension',
            actions: actionsList,
        });
        const msgPre = internal({
            to: walletV5.address,
            value: toNano('0.1'),
            body: actions,
        });
        const txFees = await tFAExtension.getEstimatedAttachedValue({
            forwardMsg: beginCell().store(storeMessageRelaxed(msgPre)).endCell(),
            outputMsgCount: actionsList.length,
            extendedActionCount: 0,
        });
        let msg = internal({
            to: walletV5.address,
            value: txFees,
            body: actions,
        });
        const res = await tFAExtension.sendSendActions({
            certificate: certificate,
            seedPrivateKey: seedKeypair.secretKey,
            seqno: 1,
            msg: beginCell().store(storeMessageRelaxed(msg)).endCell(),
            sendMode: SendMode.NONE,
        });
        expect(res.transactions).toHaveTransaction({
            from: tFAExtension.address,
            to: walletV5.address,
            success: true,
        });

        const totalFees = res.transactions.slice(0, 2).reduce((acc, tx) => acc + tx.totalFees.coins, 0n);

        const expectedFeesByMaster = await tFAMaster.getEstimatedFeesOnSendActions({
            forwardMsg: beginCell().store(storeMessageRelaxed(msg)).endCell(),
            outputMsgCount: actionsList.length,
            extendedActionCount: 0,
        });

        console.log(`[255 Transfers] Total fees: ${Number(totalFees) / 1000000000}
[255 Transfers] Calculated: ${Number(expectedFeesByMaster) / 1000000000}`);
    });

    it('test certificate generated by the FROST algorithm', async () => {
        const rootCAPublicKey = Buffer.from('18b8d9bbb1305736fbf3579bcf2a79d94eb356ad85b5045cd16a3544874f2374', 'hex');
        const certKeypair = {
            // from hex string
            publicKey: Buffer.from('f8f2b3d7379bc29c16f21c0f5aab7185291d32c60950f54ed3d9f3a3c23f6883', 'hex'),
            secretKey: Buffer.from(
                '0659792db45a655b080bb3bb5df6b825595d045dcf5189db406b8d49de4cf5b8f8f2b3d7379bc29c16f21c0f5aab7185291d32c60950f54ed3d9f3a3c23f6883',
                'hex',
            ),
        };

        const certRaw =
            'b5ee9c7201010101006a0000d00000000067bf248bf8f2b3d7379bc29c16f21c0f5aab7185291d32c60950f54ed3d9f3a3c23f6883e3506d940f8b99a7a139bbafe02738f5d4ae8244577a71d25bd12c4e8645709f041bcc5de6a6d783023008fb790c26b818a5be7eb97d1c38732796dcd61c7b04';

        blockchain = await Blockchain.create();
        blockchain.now = 1740579800;
        deployer = await blockchain.treasury('deployer');

        const certSlice = Cell.fromBoc(Buffer.from(certRaw, 'hex'))[0].beginParse();
        {
            let certSlice2 = Cell.fromBoc(Buffer.from(certRaw, 'hex'))[0].beginParse();
            let validUntil = certSlice2.loadUint(64);
            let publicKey = certSlice2.loadBuffer(256 / 8);
            expect(validUntil).toEqual(1740579979);
            expect(publicKey).toEqual(certKeypair.publicKey);
        }

        certificate = {
            validUntil: certSlice.loadUint(64),
            keypair: certKeypair,
            signature: certSlice.skip(256).loadBuffer(512 / 8),
        };

        seedKeypair = await randomKeypair();
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
            rootCAPubkey: bufferToBigInt(rootCAPublicKey),
            seedPubkey: bufferToBigInt(seedKeypair.publicKey),
        });

        expect(deployResult.transactions).toHaveTransaction({
            from: walletV5.address,
            to: tFAExtension.address,
            deploy: true,
            success: true,
        });
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(false);

        const request = walletV5.createRequest({
            seqno: await walletV5.getSeqno(),
            authType: 'extension',
            actions: [],
        });
        const msgPre = internal({
            to: walletV5.address,
            value: toNano('0.1'),
            body: request,
        });
        const txFees = await tFAExtension.getEstimatedAttachedValue({
            forwardMsg: beginCell().store(storeMessageRelaxed(msgPre)).endCell(),
            outputMsgCount: 1,
            extendedActionCount: 0,
        });
        let msg = internal({
            to: walletV5.address,
            value: txFees,
            body: request,
        });

        await tFAExtension.sendSendActions({
            certificate: certificate,
            seedPrivateKey: seedKeypair.secretKey,
            seqno: await tFAExtension.getSeqno(),
            validUntil: Math.floor(Date.now() / 1000) + 180,
            msg: beginCell().store(storeMessageRelaxed(msg)).endCell(),
            sendMode: SendMode.NONE,
        });
    });
});

function loadNotcoinCode(path: string): Cell {
    // load file content as json

    const fileContent = fs.readFileSync(path, 'utf8');
    const json = JSON.parse(fileContent);
    const hex: string = json.hex;

    return Cell.fromBoc(Buffer.from(hex, 'hex'))[0];
}

function bufferToBigInt(buffer: Buffer) {
    const bufferAsHexString = buffer.toString('hex');
    return BigInt(`0x${bufferAsHexString}`);
}

async function randomKeypair() {
    return keyPairFromSeed(await getSecureRandomBytes(32));
}

async function makeCertificate(opts: { rootCAKeypair: KeyPair; validUntil?: number }): Promise<Certificate> {
    const { rootCAKeypair, validUntil = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 } = opts;

    const certKeypair = await randomKeypair();

    return {
        keypair: certKeypair,
        validUntil,
        signature: sign(
            beginCell().storeUint(validUntil, 64).storeBuffer(certKeypair.publicKey).endCell().hash(),
            rootCAKeypair.secretKey,
        ),
    };
}
