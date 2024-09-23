import { Blockchain, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
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
import { OpCode, TFAExtension } from '../wrappers/TFAExtension';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed, sign } from '@ton/crypto';
import { Opcodes, WalletV5 } from '../wrappers/WalletV5';
import { ActionSendMsg, packActionsList } from './wallet/wallet_v5_actions';
import { SendMode } from '@ton/core';
import { deployWallet, linkExtensionToWallet } from './wallet/WalletUtils';
import { JettonMaster, WalletContractV5R1 } from '@ton/ton';
import { MessageRelaxed } from '@ton/core/src/types/MessageRelaxed';
import { Transaction } from '@ton/core';
import { jettonContentToCell, JettonMinter } from '../notcoin-contract/wrappers/JettonMinter';
import * as fs from 'fs';
import { JettonWallet } from '../notcoin-contract/wrappers/JettonWallet';

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
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and tFAExtension are ready to use
    });

    it('should send actions', async () => {
        await walletV5.sendAddExtension({
            authType: 'external',
            seqno: 1,
            secretKey: walletKeypair.secretKey,
            extensionAddress: tFAExtension.address,
        });
        const actions = walletV5.createRequest({
            seqno: 2,
            authType: 'extension',
            actions: [
                {
                    type: 'sendMsg',
                    mode: SendMode.PAY_GAS_SEPARATELY,
                    outMsg: internal({
                        to: deployer.address,
                        value: toNano('0.1'),
                    }),
                },
                // {
                //     type: 'sendMsg',
                //     mode: SendMode.PAY_GAS_SEPARATELY,
                //     outMsg: internal({
                //         to: tFAExtension.address,
                //         value: toNano('1'),
                //     }),
                // },
            ],
        });
        const payload = packSendActionsBody(serviceKeypair, deviceKeypairs[0], 0, 1, actions);
        const res = await tFAExtension.sendExternal(payload);

        // expect(res.transactions).toHaveTransaction({
        //     from: walletV5.address,
        //     to: tFAExtension.address,
        //     value: toNano('1.0'),
        //     success: true,
        // });

        expect(res.transactions).toHaveTransaction({
            from: walletV5.address,
            to: deployer.address,
            value: toNano('0.1'),
            success: true,
        });

        console.debug(
            'SINGLE EXTERNAL SEND ACTIONS GAS USED:',
            ((res.transactions[0].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm)
                .gasUsed,
        );

        {
            const actions = walletV5.createRequest({
                seqno: 2,
                secretKey: walletKeypair.secretKey,
                authType: 'external',
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
            });
            const resSimple = await walletV5.send(actions);
            const totalFeesSimple = resSimple.transactions.reduce((acc, tx) => acc + tx.totalFees.coins, 0n);
            const totalFees = res.transactions.reduce((acc, tx) => acc + tx.totalFees.coins, 0n);

            let s = `[Simple Transfer][no 2FA] Total fees: ${Number(totalFeesSimple) / 1000000000}\n`;
            s += `[Simple Transfer][   2FA] Total fees: ${Number(totalFees) / 1000000000}\n`;
            s += `[Simple Transfer] increase: ${(Number(totalFees) / Number(totalFeesSimple)).toFixed(2)}x\n`;
            console.log(s);
        }
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

        await walletV5.sendAddExtension({
            authType: 'external',
            seqno: 1,
            secretKey: walletKeypair.secretKey,
            extensionAddress: tFAExtension.address,
        });

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
                    // {
                    //     type: 'sendMsg',
                    //     mode: SendMode.PAY_GAS_SEPARATELY,
                    //     outMsg: internal({
                    //         to: tFAExtension.address,
                    //         value: toNano('1'),
                    //     }),
                    // },
                ],
            });
            const payload = packSendActionsBody(serviceKeypair, deviceKeypairs[0], 0, extensionSeqno++, actions);
            const res = await tFAExtension.sendExternal(payload);

            // expect(res.transactions).toHaveTransaction({
            //     from: walletV5.address,
            //     to: tFAExtension.address,
            //     value: toNano('1.0'),
            //     success: true,
            // });

            {
                const actions = walletV5.createRequest({
                    seqno: await walletV5.getSeqno(),
                    secretKey: walletKeypair.secretKey,
                    authType: 'external',
                    actions: [
                        {
                            type: 'sendMsg',
                            mode: SendMode.PAY_GAS_SEPARATELY,
                            outMsg: internal({
                                to: walletV5JettonWallet.address,
                                value: toNano('0.1'),
                                body: JettonWallet.transferMessage(
                                    toNano('100'),
                                    receiver2,
                                    walletV5.address,
                                    null,
                                    1n,
                                    beginCell().storeUint(10, 32).endCell(),
                                ),
                            }),
                        },
                    ],
                });
                const resSimple = await walletV5.send(actions);
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

function packSendActionsBody(
    serviceKeypair: KeyPair,
    deviceKeypair: KeyPair,
    deviceId: number,
    seqno: number,
    actionsList: Cell,
): Cell {
    const body = beginCell().storeUint(seqno, 32).storeRef(actionsList).endCell();
    const signature1 = sign(body.hash(), serviceKeypair.secretKey);
    const signature2 = sign(body.hash(), deviceKeypair.secretKey);

    const payload = beginCell()
        .storeUint(OpCode.SEND_ACTIONS, 32)
        .storeBuffer(signature1)
        .storeRef(beginCell().storeBuffer(signature2).storeUint(deviceId, 32))
        .storeSlice(body.beginParse());

    return payload.endCell();
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
