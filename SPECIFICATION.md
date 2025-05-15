# 2FA Extension Specification

## Terminology

### **Root Key**

Root key is a key that is used to sign Certificate by the Tonkeeper.

### **Certificate**

Certificate is a Cell that contains following data:

- `valid_until` - the timestamp until the certificate is valid.
- `pubkey` - the public key of the Certificate.
- `signature` - the signature of the `[valid_until, pubkey]` by the Root key.

TL-B:

```tlb
certificate_data$_ valid_until:uint64 pubkey:uint256 = CertificateData;
certificate$_ data:CertificateData signature:bits512 = Certificate;
```

The certificate private key is stored on the Tonkeeper backend and is required to sign any message sent to the extension. Any
message signed with the Seed must be signed with the Certificate as well. Extension uses Root public key to verify the Certificate.

## Installing extension

When installing the extension, following steps should be taken:
1. Add the extension to the list of extensions in the wallet.
2. Create and send a message to the extension with the following scheme:
```tl-b
install#43563174 root_pubkey:uint256 seed_pubkey:uint256 = InternalMessage;
```
where:
- `root_pubkey` is the public key of the Root.
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
- 2fa: the message is signed with the Seed and the Certificate.
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
const signature1 = sign(dataToSign.hash(), certificatePrivateKey);
const signature2 = sign(dataToSign.hash(), seedPrivateKey);

const body = beginCell()
    .storeRef(certificate)
    .storeRef(beginCell().storeBuffer(signature2))
    .storeSlice(dataToSign.beginParse())
    .storeBuffer(signature1);

return body.endCell();
```

Certificate should be constructed as follows:
```typescript
const certificateData = beginCell().storeUint(validUntil, 64).storeUint(certificatePublicKey, 256).endCell();
const signature = sign(certificateData.hash(), rootPrivateKey);

const certificate = beginCell().storeSlice(certificateData.beginParse()).storeBuffer(signature).endCell();
```

### Internal 2FA Authorization

To authorize a message with 2FA using internal message, the [2FA](#2FA) authorization scheme should be used, but
with the `0x53684037` op code.

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

const body = beginCell().storeSlice(dataToSign.beginParse()).storeBuffer(signature);

return body.endCell();
```

### TL-B Schemes

```tlb
send_actions$_ msg:^Cell mode:uint8 = Payload 0xb15f2c8c;
remove_extension$_ = Payload 0x9d8084d6;
delegation$_ new_state_init:^Cell forward_amount:Coins = Payload 0x23d9c15c;
cancel_delegation$_ = Payload 0xde82b501;

signed_2fa_external$_ 
    ref_with_certificate:^Certificate
    ref_with_seed_signature:^[seed_signature:bits512] 
    op_code:uint32 seqno:uint32 valid_until:uint64 payload:(Payload op_code)
    certificate_signature:bits512 
    = ExternalMsgBody;
signed_seed_external$_
    op_code:uint32 seqno:uint32 valid_until:uint64 payload:(Payload op_code)
    seed_signature:bits512
    = ExternalMsgBody;
    
signed_2fa_internal#53684037 
    ref_with_certificate:^Certificate
    ref_with_seed_signature:^[seed_signature:bits512] 
    op_code:uint32 seqno:uint32 valid_until:uint64 payload:(Payload op_code)
    certificate_signature:bits512 
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

## Get Methods

- `int get_seqno()` - returns the current seqno.
- `int get_wallet_addr()` - returns the wallet address.
- `int get_root_pubkey()` - returns the root public key.
- `int get_seed_pubkey()` - returns the seed public key.
- `(int, int, tuple) get_delegation_state()` - returns the delegation state. First parameter is the `state tag`. 
Second parameter is the `blocked_until`. Third parameter is the state params.
- `int get_estimated_attached_value(cell msg, int msg_actions, int ext_actions)` - returns TON amount that should be attached
to the message to the wallet. The first parameter is the serialized message. The second parameter is the
number of outbound messages in the action list. The third parameter is the number of extended actions in the action list.

# 2FA Master

Master contract is currently used only to call one get method as follows.

Current Master Contract: https://tonviewer.com/EQC_BHePjsa-LJhws0QxqEnWtmMZFjYJPVT7gJHZ5uuibP_b

## Get Methods

- `int get_estimated_fees_on_send_actions(cell msg, int msg_actions, int ext_actions)` - returns the TON amount that 
  will be used from the extension’s balance to cover blockchain fees. This value is a slight overestimate. The 
  parameters are the same as those in `get_estimated_attached_value`.

# Known Vulnerabilities

## Replay Attack when Activating Extension Twice

### Vulnerability Description
A replay attack can occur if the extension is installed twice under specific conditions:

### Steps to Reproduce
1. Install the extension as described in the [Installing Extension](#installing-extension) section.
2. Send a transaction using the `send_actions` method via the extension.
3. Deactivate the extension using the `remove_extension` method.
4. Re-install the extension.
5. An attacker can now replay the transaction from step 2, as the seqno is reset to 0.

> Steps 3 and 4 must be completed within the transaction's TTL for the attack to be possible.

### Impact Assessment
While technically a vulnerability, its practical impact is minor due to several prerequisites:
- The user must install the extension twice.
- A transaction must be sent between the installations.
- The re-installation must happen within the TTL of the initial transaction (typically 5 minutes).

Given these conditions, the likelihood of real-world exploitation is very low.

### Current Mitigation
Backend service must prevent re-installation within a TTL window (5 minutes) after destruction. 
Future contract versions may introduce a more sophisticated solution.

> Note: This vulnerability is known and does not qualify for the Tonkeeper Bug Bounty Program.