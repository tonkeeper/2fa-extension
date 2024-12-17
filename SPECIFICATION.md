# 2FA Extension Specification

## Terminology

### **Service Key (SK)**

The service key is stored on the Tonkeeper backend and is required to sign any message sent to the extension. Any
message signed with the Seed must be signed with the SK as well. The SK is unique for each account.

## Installing extension

When installing the extension, following steps should be taken:
1. Add the extension to the list of extensions in the wallet.
2. Create and send a message to the extension with the following scheme:
```tl-b
install#43563174 service_pubkey:uint256 seed_pubkey:uint256 = InternalMessage;
```
where:
- `service_pubkey` is the public key of the service key.
- `seed_pubkey` is the public key of the Seed.

The `state_init` data should be constructed as follows:
```typescript
beginCell()
    .storeUint(0, 32)
    .storeAddress(walletAddress)
    .storeUint(0, 256)
    .storeUint(0, 256)
    .storeUint(0, 2)
    .storeUint(0, 64)
    .endCell();
```

After the above message is sent, the extension will send a message to the wallet that will disable the public
key signature authorization.

## Balance

Sending 255 transfers is required around 0.5 ton to execute such transaction before the transfers is made. So, it is 
proposed to keep at least 0.5 ton on the balance and refill the extension balance if it is less than 0.5 ton.
To replenish the balance, simple message without body should be sent to the extension.

## Authorization

There are 2 types of authorization:
- 2fa: the message is signed with the Seed and the service key.
- Seed: the message is signed with the Seed.

### 2FA

To authorize a message with 2FA, the following scheme of the message should be used:

```typescript
const dataToSign = beginCell()
    .storeUint(opCode, 32) // op code of the method
    .storeUint(seqno, 32)
    .storeUint(validUntil, 64)
    .storeBuilder(payload) // payload of the method
    .endCell();
const signature1 = sign(dataToSign.hash(), servicePrivateKey);
const signature2 = sign(dataToSign.hash(), seedPrivateKey);

const body = beginCell()
    .storeBuffer(signature1)
    .storeRef(beginCell().storeBuffer(signature2))
    .storeSlice(dataToSign.beginParse());

return body.endCell();
```

### Seed Authorization

To authorize a message with Seed, the following scheme of the message should be used:

```typescript
const dataToSign = beginCell()
    .storeUint(opCode, 32)
    .storeUint(seqno, 32)
    .storeUint(validUntil, 64)
    .storeBuilder(payload)
    .endCell();
const signature = sign(dataToSign.hash(), seedPrivateKey);

const body = beginCell().storeBuffer(signature).storeSlice(dataToSign.beginParse());

return body.endCell();
```

### TL-B Schemes

```tlb
signed_2fa_external#_ 
    service_signature:bits512 
    ref_with_seed_signature:^[seed_signature:bits512] 
    op_code:uint32 seqno:uint32 valid_until:uint64 payload:Cell
    = ExternalMsgBody;
signed_seed_external#_
    seed_signature:bits512
    op_code:uint32 seqno:uint32 valid_until:uint64 payload:Cell
    = ExternalMsgBody;
```

## Methods

### `send_actions`

Requires [2FA](#2FA) authorization.

```tl-b
send_actions#b15f2c8c msg:^Cell mode:uint8 = ExternalMessage;
```

where:
- `msg` is a serialized message that would be put into the `send_raw_msg` method. It is supposed that this method is
  used to send messages to the wallet, but any message can be sent in case of necessity.
- `mode` is a mode of the message that would be put into the `send_raw_msg` method.

### `remove_extension`

Requires [2FA](#2FA) authorization.

```tl-b
remove_extension#9d8084d6 = ExternalMessage;
```

This method is used to delete the extension from the wallet. It enables the public key signature authorization, removes
the extension from the list of extensions, and deletes the extension smart contract.

WARNING: This method is dangerous because Seed can be compromised, but the fact that it is compromised may be unknown.
The attacker can wait until the extension is deleted and then use the stolen seed phrase to directly access the wallet.
It is strongly recommended to not use this method.

### `delegation`

Requires [Seed](#Seed-Authorization) authorization.

```tl-b
delegation#23d9c15c new_state_init:^Cell forward_amount:Coins = ExternalMessage;
```

where:
- `new_state_init` is a state_init of the new extension that will be created after disabling the current extension.
- `forward_amount` is the amount of ton that will be transferred to the new extension when creating it.

This method is used to disable the extension. It removes the extension from the list of extensions and creates a
new extension with the `new_state_init` state and adds new extension to the list of extensions. 

How it works:
1. The extension received a message with the `delegation` method.
2. If it is the first time the method is called, extension state turns to the `delegation` state.
3. Before performing the next step, a delay of 14 days must be completed.
4. If the current state is `delegation`, the extension will send a message to the wallet to create a new extension 
with the `new_state_init` state.

### `cancel_delegation`

Requires [Seed](#Seed-Authorization) authorization.

```tl-b
cancel_delegation#de82b501 = ExternalMessage;
```

This method is used to cancel `delegation`. If the current state is `delegation`, it resets to the
`none` state.

### TL-B schemes

```tl-b
install#43563174 service_pubkey:uint256 seed_pubkey:uint256 device_pubkeys:(Dict uint32 uint256) = InternalMessage;

send_actions#b15f2c8c msg:^Cell mode:uint8 = ExternalMessage;
remove_extension#9d8084d6 = ExternalMessage;
delegation#23d9c15c new_state_init:^Cell forward_amount:Coins = ExternalMessage;
cancel_delegation#de82b501 = ExternalMessage;
```

## Get Methods

- `int get_seqno()` - returns the current seqno.
- `int get_wallet_addr()` - returns the wallet address.
- `int get_service_pubkey()` - returns the service public key.
- `int get_seed_pubkey()` - returns the seed public key.
- `(int, int, tuple) get_delegation_state()` - returns the delegation state. First parameter is the `state tag`. 
Second parameter is the `blocked_until`. Third parameter is the state params.
- `int get_estimated_attached_value(cell msg, int msg_actions, int ext_actions)` - returns TON amount that should be attached
to the message to the wallet. The first parameter is the serialized message. The second parameter is the
number of outbound messages in the action list. The third parameter is the number of extended actions in the action list.