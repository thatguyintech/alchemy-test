import { Alchemy, AssetTransfersCategory, Network, NftMetadata } from "alchemy-sdk";
import dotenv from "dotenv";

dotenv.config();

// Available in alchemy-sdk 3.4.4
// const networkToTest = [
//     Network.AVAX_MAINNET,
//     Network.AVAX_FUJI,
//     Network.LINEA_MAINNET,
//     Network.LINEA_SEPOLIA,
//     Network.ZETACHAIN_MAINNET,
//     Network.ZETACHAIN_TESTNET,
//     Network.ZORA_MAINNET,
//     Network.ZORA_TESTNET,
// ]

const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.LINEA_SEPOLIA,
});

type TokenAmount = {
    balance: bigint;
    decimals: number;
}

function filterNFTMetadata(
  nftMetadata: NftMetadata,
  filterMetadata: Partial<NftMetadata>,
) {
  // if there are no filters defined, then any nft is a match
  if (!filterMetadata) {
    return true;
  }

  const topLevelAttrs = Object.entries(filterMetadata).filter(
    ([k, _]) => k !== "attributes",
  );

  // compare top-level attributes first
  for (const [k, v] of topLevelAttrs) {
    if (nftMetadata[k.toLowerCase()] !== v) {
      return false;
    }
  }

  // if filterMetadata exists, then nftMetadata must also exist otherwise it's not a match
  if (filterMetadata.attributes && filterMetadata.attributes.length > 0) {
    if (!nftMetadata || nftMetadata.attributes == undefined) {
      // filter exists but nft doesn't have any metadata
      return false;
    }
    if (filterMetadata.attributes.length > nftMetadata.attributes.length) {
      // filter exists and has more requirements than nft metadata provides
      return false;
    }
  }

  // sanity check: nftMetadata should exist at this point
  if (!nftMetadata) {
    return false;
  }

  // compare nested attributes next
  if (
    nftMetadata.attributes != undefined &&
    filterMetadata.attributes != undefined
  ) {
    const nestedAttrs = {} as Record<string, any>;
    for (const nftAttr of nftMetadata.attributes) {
      nestedAttrs[nftAttr["trait_type"].toLowerCase()] = nftAttr["value"];
    }
    for (const filterAttr of filterMetadata.attributes) {
      if (
        nestedAttrs[filterAttr["trait_type"].toLowerCase()] !=
        filterAttr["value"]
      ) {
        return false;
      }
    }
  }
  return true;
}

// ERC20 token balance check
const erc20 = async (
  walletAddress: string,
  contractAddress: string,
) => {
  if (walletAddress == undefined) return { balance: 0n, decimals: 0 };

  const metadata = await alchemy.core.getTokenMetadata(contractAddress);
  const result = await alchemy.core.getTokenBalances(walletAddress, [contractAddress]);

  for (const tokenBalance of result.tokenBalances) {
    if (
      tokenBalance.contractAddress == contractAddress &&
      tokenBalance.tokenBalance &&
      metadata.decimals
    ) {
      return {
          balance: BigInt(tokenBalance.tokenBalance),
          decimals: metadata.decimals,
      } as TokenAmount;
    }
  }

  return { balance: 0n, decimals: 0 } as TokenAmount;
}

const checkErc20 = async (walletAddress: string, contractAddress: string) => {
  console.log(`\n===ERC20 token balance check===\n`);
  const tokenAmount = await erc20(walletAddress, contractAddress);
  console.log(`Balance: ${tokenAmount.balance}`);
  console.log(`Decimals: ${tokenAmount.decimals}`);
  const formatted = Number(tokenAmount.balance) / Math.pow(10, tokenAmount.decimals);
  console.log(`Formatted balance: ${formatted}`);
}

// // Native token balance check 
const nativeToken = async ( walletAddress: string ) => {
  if (walletAddress === undefined) return { balance: 0n, decimals: 0 };

  // Get the native token balance of the wallet.
  const result = await alchemy.core.getBalance(walletAddress, "latest");

  // Assume 18 decimals for native token unit conversion. All chains supported
  // by Alchemy so far are 18 decimals (Eth, Matic, OpETH, ArbETH).
  return {
    balance: result.toBigInt(),
    decimals: 18,
  } as TokenAmount;
}

const checkNativeToken = async (walletAddress: string) => {
  console.log(`\n===Native token balance check===\n`);
  const tokenAmount = await nativeToken(walletAddress);
  console.log(`Balance: ${tokenAmount.balance}`);
  console.log(`Decimals: ${tokenAmount.decimals}`);
  const formatted = Number(tokenAmount.balance) / Math.pow(10, tokenAmount.decimals);
  console.log(`Formatted balance: ${formatted}`);
}

const contractDeploymentTransactions = async (
  walletAddress: string,
) => {
  console.log(`\n===Contract deployment transactions===\n`);
  // paginate through all the wallet transactions
  const transfers = [];
  const transactionConfig = {
    fromBlock: "0x0",
    toBlock: "latest", // Fetch results up to the latest block
    fromAddress: walletAddress, // Filter results to only include transfers from the specified address
    excludeZeroValue: false, // Include transfers with a value of 0
    category: [AssetTransfersCategory.EXTERNAL], // Filter results to only include external transfers
  };
  let response = await alchemy.core.getAssetTransfers(transactionConfig);
  transfers.push(...response.transfers);

  // Continue fetching and aggregating results while there are more pages
  while (response.pageKey) {
    const pageKey = response.pageKey;
    response = await alchemy.core.getAssetTransfers({
      ...transactionConfig,
      pageKey: pageKey,
    });
    transfers.push(...response.transfers);
  }
  console.log(`total transfer txns: ${transfers.length}`);

  // Filter the transfers to only include contract deployments (where 'to' is null)
  const deployments = transfers.filter((transfer) => transfer.to === null);
  const txHashes = deployments.map((deployment) => deployment.hash);

  // Fetch the transaction receipts for each of the deployment transactions
  const promises = txHashes.map((hash) =>
    alchemy.core.getTransactionReceipt(hash),
  );

  // Wait for all the transaction receipts to be fetched
  const txReceipts = await Promise.all(promises);
  const contractDeploymentTransactions = txReceipts.map((receipt) => ({
    from: walletAddress,
    to: null,
    hash: receipt?.transactionHash,
    value: 0n,
  }));
  console.log(
    `total contract deployments: ${txReceipts.length}`,
  );
  return { txns: contractDeploymentTransactions };
}

// NFT checks
const nft = async (walletAddress: string, nftContractAddress: string, nftMetadata: NftMetadata) => {
  console.log(`\n===NFT check===\n`);
  if (walletAddress == undefined) return { balance: 0, nftData: [] };

  console.log(
    `Querying NFTs for wallet: ${walletAddress} and contract: ${nftContractAddress}`,
  );
  const result = await alchemy.nft.getNftsForOwner(walletAddress, {
    contractAddresses: [nftContractAddress],
  });

  // TODO(albert): deprecate TokenBalance in favor of TokenAmount, which uses
  // bigints to represent super large numbers to more accurately represent
  // crypto asset holdings.
  const output = {
    balance: 0,
    nftData: [] as NftMetadata[],
  };

  // Filter balance/returned metadata based on
  // tokenId or metadata filters
  for (const nft of result.ownedNfts) {
    let match = true;

    if (nftMetadata && nft.raw.metadata) {
      match =
        match && filterNFTMetadata(nft.raw.metadata, nftMetadata);
    }

    if (nftMetadata.tokenId) {
      match = match && nft.tokenId == nftMetadata.tokenId.toString();
    }

    if (match) {
      // TODO: Once output is represented as a TokenAmount and balance is a
      // bigint, we should do a proper conversion here instead of simply
      // casting to a number. For now we're ok with this casting solution
      // because we don't expect many users to have more than 2^53 NFTs in a
      // wallet.
      if (isNaN(+nft.balance)) {
        console.log(`NFT balance is NaN: ${nft.balance}`);
      } else {
        output.balance += +nft.balance;
      }
      if (nft.raw.metadata) {
        output.nftData.push({
          ...nft.raw.metadata,
          tokenId: Number(nft.tokenId),
          tokenType: nft.tokenType,
        });
      }
    }
  }
  console.log(`total NFTs: ${output.nftData.length}`);
  for (const nft of output.nftData) {
    console.log(nft.name);
  }
  return output;
}

const main = async () => {
  const walletAddress = "0x228466F2C715CbEC05dEAbfAc040ce3619d7CF0B";
  const erc20ContractAddress = "0x75263A05D788da205a0fB719a4Fa93a403e0cBc0";  // Zora on Zora Mainnet

  try {
    await checkErc20(walletAddress, erc20ContractAddress);
    await checkNativeToken(walletAddress);
    await contractDeploymentTransactions(walletAddress);
    await nft(walletAddress, "0x1195Cf65f83B3A5768F3C496D3A05AD6412c64B7", {});
  } catch (error) {
    console.error("Error:", error);
  }
}

// Execute the main function
main().catch(console.error);
